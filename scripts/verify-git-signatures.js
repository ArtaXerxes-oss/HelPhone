#!/usr/bin/env node

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const rangeFlag = args.find(arg => arg.startsWith('--range='));
const range = rangeFlag ? rangeFlag.split('=')[1] : null;

function getCommitRange() {
  if (range) return range;

  try {
    const mergeBase = execSync('git merge-base origin/main HEAD', { encoding: 'utf-8' }).trim();
    return `${mergeBase}..HEAD`;
  } catch {
    return 'HEAD~5..HEAD';
  }
}

function getCommits(commitRange) {
  try {
    const output = execSync(
      `git log ${commitRange} --format=%H%n%aN%n%aE%n%G?%n%GG%n--END--`,
      { encoding: 'utf-8' }
    );

    const commits = [];
    const lines = output.split('\n');
    let i = 0;

    while (i < lines.length) {
      if (lines[i] === '--END--') {
        i++;
        continue;
      }

      const hash = lines[i];
      if (!hash) break;

      const authorName = lines[i + 1] || '';
      const authorEmail = lines[i + 2] || '';
      const signatureStatus = lines[i + 3] || 'N';
      const signatureText = lines[i + 4] || '';

      commits.push({
        hash: hash.substring(0, 7),
        fullHash: hash,
        authorName,
        authorEmail,
        signatureStatus,
        signatureText
      });

      i += 5;
    }

    return commits;
  } catch (error) {
    console.error('Failed to get commits:', error.message);
    return [];
  }
}

function verifySignatures(commits) {
  let unsigned = [];
  let unverified = [];
  let verified = [];

  for (const commit of commits) {
    if (commit.signatureStatus === 'G') {
      verified.push(commit);
      console.log(`✓ ${commit.hash} signed by ${commit.authorName}`);
    } else if (commit.signatureStatus === 'B' || commit.signatureStatus === 'E') {
      unverified.push(commit);
      console.warn(`⚠ ${commit.hash} has BAD/ERROR signature`);
    } else if (commit.signatureStatus === 'U') {
      unverified.push(commit);
      console.warn(`⚠ ${commit.hash} UNTRUSTWORTHY signature`);
    } else {
      unsigned.push(commit);
      console.error(`✗ ${commit.hash} UNSIGNED (${commit.authorName})`);
    }
  }

  return { verified, unverified, unsigned };
}

function enforcePolicy(results) {
  const { verified, unverified, unsigned } = results;

  if (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') {
    if (unsigned.length > 0) {
      console.error('\n❌ CI Policy: Unsigned commits detected on main deployment branch');
      console.error(`Found ${unsigned.length} unsigned commit(s):`);
      unsigned.forEach(c => {
        console.error(`  - ${c.hash}: ${c.authorName} <${c.authorEmail}>`);
      });
      process.exit(1);
    }

    if (unverified.length > 0) {
      console.warn('\n⚠️ Warning: Some signatures could not be verified');
    }
  } else {
    if (unsigned.length > 0) {
      console.warn('\n⚠️ Development: Unsigned commits found (only enforced in CI)');
    }
  }

  console.log(`\nSummary: ${verified.length} verified, ${unverified.length} unverified, ${unsigned.length} unsigned`);
  return unsigned.length === 0;
}

async function main() {
  const commitRange = getCommitRange();
  console.log(`Verifying signatures for: ${commitRange}\n`);

  const commits = getCommits(commitRange);
  if (commits.length === 0) {
    console.log('No commits to verify.');
    process.exit(0);
  }

  const results = verifySignatures(commits);
  const passed = enforcePolicy(results);

  process.exit(passed ? 0 : 1);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
