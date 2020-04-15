/*!
 * Copyright (c) 2018-2020 Digital Bazaar, Inc. All rights reserved.
 */
/* jshint node: true */

'use strict';

const axios = require('axios');
const bedrock = require('bedrock');
const brAccount = require('bedrock-account');
const brHttpsAgent = require('bedrock-https-agent');
const brPassport = require('bedrock-passport');
const database = require('bedrock-mongodb');
const {promisify} = require('util');
const {util: {uuid}} = bedrock;
const {EdvClient} = require('edv-client');
const didKeyDriver = require('did-method-key').driver();
const {suites, sign, SECURITY_CONTEXT_V2_URL} = require('jsonld-signatures');
const {KeystoreAgent, KmsClient, CapabilityAgent} = require('webkms-client');
const {CapabilityDelegation} = require('ocapld');
const {Ed25519Signature2018, RsaSignature2018} = suites;
const sinon = require('sinon');
const {Ed25519KeyPair} = require('crypto-ld');

// for key generation
exports.KMS_MODULE = 'ssm-v1';
// algorithm required for the jwe headers
exports.JWE_ALG = 'ECDH-ES+A256KW';

const largeRange = Number.MAX_SAFE_INTEGER - Math.pow(2, 32);

// gets a number between MAX_SAFE_INTEGER & 2^32.
exports.largeNumber = () => {
  // if Math.random is 1 the number will be 2^32 otherwise it will be larger.
  return Number.MAX_SAFE_INTEGER - Math.floor(largeRange * Math.random());
};

exports.makeDelegationTesters = async ({testers = [], mockData}) => {
  const actors = await exports.getActors(mockData);
  const accounts = mockData.accounts;
  const testData = {};
  for(const tester of testers) {
    const email = `${tester}@example.com`;
    const testerData = testData[tester] = {
      email,
      secret: uuid(),
      handle: `${tester}Key`,
      actor: actors[email],
      account: accounts[email]
    };
    testerData.capabilityAgent = await CapabilityAgent.fromSecret({
      secret: testerData.secret,
      handle: testerData.handle
    });
    const keystoreAgent = testerData.keystoreAgent =
      await exports.createKeystore({
        capabilityAgent: testerData.capabilityAgent,
        referenceId: testerData.secret
      });
    testerData.keyAgreementKey = await keystoreAgent.generateKey(
      {type: 'keyAgreement', kmsModule: exports.KMS_MODULE});
    testerData.verificationKey = await keystoreAgent.generateKey(
      {type: 'Ed25519VerificationKey2018', kmsModule: exports.KMS_MODULE});
    testerData.hmac = await keystoreAgent.generateKey(
      {type: 'hmac', kmsModule: exports.KMS_MODULE});
  }
  return testData;
};

exports.createAccount = email => {
  const newAccount = {
    id: 'urn:uuid:' + uuid(),
    email
  };
  return newAccount;
};

exports.getActors = async mockData => {
  const actors = {};
  for(const [key, record] of Object.entries(mockData.accounts)) {
    actors[key] = await brAccount.getCapabilities({id: record.account.id});
  }
  return actors;
};

exports.prepareDatabase = async mockData => {
  await exports.removeCollections();
  await insertTestData(mockData);
};

exports.removeCollections = async (
  collectionNames = [
    'account',
    'edvConfig',
    'edvDoc',
    'edvDocChunk'
  ]) => {
  await promisify(database.openCollections)(collectionNames);
  for(const collectionName of collectionNames) {
    await database.collections[collectionName].remove({});
  }
};

exports.removeCollection =
  async collectionName => exports.removeCollections([collectionName]);

async function insertTestData(mockData) {
  const records = Object.values(mockData.accounts);
  for(const record of records) {
    try {
      await brAccount.insert(
        {actor: null, account: record.account, meta: record.meta || {}});
    } catch(e) {
      if(e.name === 'DuplicateError') {
        // duplicate error means test data is already loaded
        continue;
      }
      throw e;
    }
  }
}

// the `keystores` endpoint uses session based authentication which is
// mocked
exports.createKeystore = async ({capabilityAgent, referenceId}) => {
  // create keystore
  const config = {
    sequence: 0,
    controller: capabilityAgent.id,
    invoker: capabilityAgent.id,
    delegator: capabilityAgent.id
  };
  if(referenceId) {
    config.referenceId = referenceId;
  }
  const kmsBaseUrl = `${bedrock.config.server.baseUri}/kms`;
  const {httpsAgent} = brHttpsAgent;
  const keystore = await KmsClient.createKeystore({
    url: `${kmsBaseUrl}/keystores`,
    config,
    httpsAgent,
  });
  const kmsClient = new KmsClient({httpsAgent});
  return new KeystoreAgent({capabilityAgent, keystore, kmsClient});
};

exports.createEdv = async ({
  actor, capabilityAgent, keystoreAgent, kmsModule = exports.KMS_MODULE, urls,
  keyAgreementKey, hmac, invocationSigner
}) => {
  if(!(keyAgreementKey && hmac) && keystoreAgent) {
    // create KAK and HMAC keys for edv config
    ([keyAgreementKey, hmac] = await Promise.all([
      keystoreAgent.generateKey({type: 'keyAgreement', kmsModule}),
      keystoreAgent.generateKey({type: 'hmac', kmsModule})
    ]));
  }

  // create edv
  let newEdvConfig;
  if(!invocationSigner) {
    newEdvConfig = {
      sequence: 0,
      controller: actor.id,
      // TODO: add `invoker` and `delegator` using capabilityAgent.id *or*, if
      // this is a profile's edv, the profile ID
      invoker: capabilityAgent.id,
      delegator: capabilityAgent.id,
      keyAgreementKey: {id: keyAgreementKey.id, type: keyAgreementKey.type},
      hmac: {id: hmac.id, type: hmac.type}
    };
  } else {
    newEdvConfig = {
      sequence: 0,
      controller: capabilityAgent.id,
      // TODO: add `invoker` and `delegator` using controllerKey.id *or*, if
      // this is a profile's edv, the profile ID
      invoker: capabilityAgent.id,
      delegator: capabilityAgent.id,
      keyAgreementKey: {id: keyAgreementKey.id, type: keyAgreementKey.type},
      hmac: {id: hmac.id, type: hmac.type}
    };
  }

  const {httpsAgent} = brHttpsAgent;
  const edvConfig = await EdvClient.createEdv({
    config: newEdvConfig,
    httpsAgent,
    invocationSigner,
    url: urls.edvs,
  });

  const edvClient = new EdvClient({
    id: edvConfig.id,
    keyResolver: _keyResolver,
    keyAgreementKey,
    hmac,
    httpsAgent,
    invocationSigner,
  });

  return {edvClient, edvConfig};
};

const DEFAULT_HEADERS = {Accept: 'application/ld+json, application/json'};
// FIXME: make more restrictive, support `did:key` and `did:v1`
async function _keyResolver({id}) {
  if(id.startsWith('did:key:')) {
    return didKeyDriver.get({url: id});
  }
  const {httpsAgent} = brHttpsAgent;
  const response = await axios.get(id, {
    headers: DEFAULT_HEADERS,
    httpsAgent,
  });
  return response.data;
}

/**
 * Delegates a zCap.
 *
 * @param {object} options - Options to use.
 * @param {object} options.zcap - A valid zCap with another user
 *   as the invoker and delegator.
 * @param {object} options.signer - A capabilityAgent.getSigner()
 *   from the someone higher in the capabilityChain than the invoker.
 * @param {Array<string>} options.capabilityChain = An array of ids
 *   that must start with the rootCapability first.
 *
 * @returns {Promise<object>} A signed zCap with a Linked Data Proof.
 */
exports.delegate = async ({zcap, signer, capabilityChain}) => {
  if(!zcap['@context']) {
    zcap['@context'] = SECURITY_CONTEXT_V2_URL;
  }
  if(!zcap.id) {
    zcap.id = `urn:zcap:${uuid()}`;
  }
  let Suite = null;
  if(/^Ed25519/i.test(signer.type)) {
    Suite = Ed25519Signature2018;
  }
  if(/^RSA/i.test(signer.test)) {
    Suite = RsaSignature2018;
  }
  if(!Suite) {
    throw new Error(`Unsupported key type ${signer.type}`);
  }
  // attach capability delegation proof
  return sign(zcap, {
    // TODO: map `signer.type` to signature suite
    suite: new Suite({
      signer,
      verificationMethod: signer.id
    }),
    purpose: new CapabilityDelegation({capabilityChain}),
    compactProof: false
  });
};

exports.stubPassport = ({actor}) => {
  const passportStub = sinon.stub(brPassport, 'optionallyAuthenticated');
  passportStub.callsFake((req, res, next) => {
    req.user = {
      account: {},
      actor,
    };
    next();
  });
  return passportStub;
};

exports.setKeyId = async key => {
  // the keyDescription is required to get publicKeyBase58
  const keyDescription = await key.getKeyDescription();
  // create public ID (did:key) for bob's key
  // TODO: do not use did:key but support a did:v1 based key.
  const fingerprint = Ed25519KeyPair.fingerprintFromPublicKey(keyDescription);
  // invocationTarget.verificationMethod = `did:key:${fingerprint}`;
  key.id = `did:key:${fingerprint}#${fingerprint}`;
};
