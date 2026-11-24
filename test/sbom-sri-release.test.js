import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { generateSBOM } from "../scripts/generate-sbom.js";
import {
  computeSHA384,
  generateLocalSRIHashes,
  injectLocalSRIIntoHTML,
  verifySRIHashes,
} from "../scripts/generate-sri-hashes.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "helphone-sbom-sri-"));

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("SBOM & SRI release integration (#950)", () => {
  it("generates a CycloneDX SBOM offline from package-lock.json", () => {
    const projectDir = path.join(TMP, "proj");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "helphone", version: "1.0.0" },
          "node_modules/react": { version: "19.2.7", integrity: "sha512-abc" },
        },
      }),
    );
    const outFile = path.join(projectDir, "dist", "sbom.json");
    const bom = generateSBOM({ root: projectDir, outFile, offline: true });

    expect(bom.bomFormat).toBe("CycloneDX");
    expect(bom.components.length).toBe(1);
    expect(bom.components[0].name).toBe("react");
    expect(fs.existsSync(outFile)).toBe(true);
  });

  it("injects and verifies SRI hashes and fails when an asset is tampered", () => {
    const distDir = path.join(TMP, "dist");
    const assetsDir = path.join(distDir, "assets");
    fs.mkdirSync(assetsDir, { recursive: true });

    const jsContent = 'console.log("helphone");';
    const jsPath = path.join(assetsDir, "app.js");
    fs.writeFileSync(jsPath, jsContent);

    const htmlPath = path.join(distDir, "index.html");
    fs.writeFileSync(
      htmlPath,
      '<!doctype html><html><head><script type="module" src="/assets/app.js"></script></head></html>',
    );

    const localAssets = generateLocalSRIHashes(distDir);
    expect(localAssets["assets/app.js"].integrity).toBe(
      `sha384-${computeSHA384(jsContent)}`,
    );

    const injected = injectLocalSRIIntoHTML(htmlPath, localAssets);
    expect(injected).toBe(true);

    const sriPath = path.join(distDir, "sri-hashes.json");
    fs.writeFileSync(
      sriPath,
      JSON.stringify({ algorithm: "sha384", localAssets }, null, 2),
    );

    const okResult = verifySRIHashes({ distDir, sriPath, htmlPath });
    expect(okResult.ok).toBe(true);
    expect(okResult.checked).toBe(1);

    // Tamper with asset
    fs.writeFileSync(jsPath, 'console.log("tampered");');
    const badResult = verifySRIHashes({ distDir, sriPath, htmlPath });
    expect(badResult.ok).toBe(false);
    expect(badResult.problems[0]).toContain("SRI mismatch for assets/app.js");
  });
});
