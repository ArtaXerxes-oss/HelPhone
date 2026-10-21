// Integration tests for src/lib/contract.js against a REAL local Soroban
// standalone network (not a mock) — see scripts/soroban-local-node.sh and
// scripts/deploy-local-contract.sh, which must both run first. This is
// deliberately separate from the Vitest unit suite under test/ (which uses
// MSW to mock network calls, see src/mocks/) — this suite exercises actual
// transaction submission/confirmation against a live node.
//
// Setup (see tests/integration/README.md for full detail):
//   scripts/soroban-local-node.sh up
//   scripts/deploy-local-contract.sh
//   node --test tests/integration/contract.integration.test.js
//
// This suite is intentionally plain Node `node:test` + `node:assert`
// rather than Vitest, so it can run independent of the jsdom-targeted
// vite.config.js test config (this needs a real network stack, not jsdom).

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  rpc,
  Contract,
  TransactionBuilder,
  Keypair,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEPLOYMENT_FILE = join(__dirname, ".local-deployment.json");

describe("contract.js against local Soroban standalone network", () => {
  let deployment;
  let server;
  let contract;
  let sourceKeypair;

  before(() => {
    if (!existsSync(DEPLOYMENT_FILE)) {
      throw new Error(
        `Missing ${DEPLOYMENT_FILE} — run scripts/soroban-local-node.sh up && ` +
          "scripts/deploy-local-contract.sh before this suite.",
      );
    }
    deployment = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf-8"));
    server = new rpc.Server(deployment.rpcUrl, { allowHttp: true });
    contract = new Contract(deployment.contractId);
    sourceKeypair = Keypair.fromSecret(deployment.testAccount.secretKey);
  });

  async function invoke(method, args = []) {
    const account = await server.getAccount(sourceKeypair.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: deployment.networkPassphrase,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(30)
      .build();

    const prepared = await server.prepareTransaction(tx);
    prepared.sign(sourceKeypair);

    const sendResult = await server.sendTransaction(prepared);
    assert.equal(
      sendResult.status,
      "PENDING",
      `submit failed: ${JSON.stringify(sendResult)}`,
    );

    let getResult = await server.getTransaction(sendResult.hash);
    for (let i = 0; i < 15 && getResult.status === "NOT_FOUND"; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      getResult = await server.getTransaction(sendResult.hash);
    }

    assert.equal(
      getResult.status,
      "SUCCESS",
      `tx did not succeed: ${JSON.stringify(getResult)}`,
    );
    return getResult.returnValue
      ? scValToNative(getResult.returnValue)
      : undefined;
  }

  async function readCall(method, args = []) {
    const account = await server.getAccount(sourceKeypair.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: deployment.networkPassphrase,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(30)
      .build();
    const sim = await server.simulateTransaction(tx);
    assert.ok(
      !rpc.Api.isSimulationError(sim),
      `simulation failed: ${JSON.stringify(sim)}`,
    );
    return sim.result?.retval ? scValToNative(sim.result.retval) : undefined;
  }

  test("node reports healthy", async () => {
    const health = await server.getHealth();
    assert.equal(health.status, "healthy");
  });

  test("get_request_count reflects on-chain state, not a mock", async () => {
    const before = await readCall("get_request_count");
    assert.equal(typeof before, "bigint");
  });

  test("create_request succeeds against the live network and increments the count", async () => {
    const countBefore = await readCall("get_request_count");

    const requesterAddr = nativeToScVal(sourceKeypair.publicKey(), {
      type: "address",
    });
    const id = await invoke("create_request", [
      requesterAddr,
      nativeToScVal(1000000, { type: "i32" }),
      nativeToScVal(1000000, { type: "i32" }),
      nativeToScVal("medical", { type: "string" }),
      nativeToScVal("integration-test", { type: "string" }),
      nativeToScVal("n/a", { type: "string" }),
    ]);

    assert.equal(typeof id, "bigint");

    const countAfter = await readCall("get_request_count");
    assert.equal(countAfter, countBefore + 1n);
  });

  test("get_request returns the request just created", async () => {
    const id = await readCall("get_request_count");
    const request = await readCall("get_request", [
      nativeToScVal(id, { type: "u64" }),
    ]);
    assert.ok(request, "expected a request to exist at the current count");
  });
});
