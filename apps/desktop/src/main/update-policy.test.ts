import { describe, expect, it } from 'vitest';
import { isNewer, updatePolicy } from './update-policy';

describe('whether Sheep may update itself', () => {
  it('never updates a checkout', () => {
    for (const signed of [true, false]) {
      const policy = updatePolicy({ packaged: false, signed });
      expect(policy.enabled).toBe(false);
      expect(!policy.enabled && policy.reason).toMatch(/running from source/);
    }
  });

  it('never updates an unsigned build, and says where new versions are instead', () => {
    const policy = updatePolicy({ packaged: true, signed: false });
    expect(policy.enabled).toBe(false);
    expect(!policy.enabled && policy.reason).toMatch(/not signed.*no publisher to verify/);
    expect(!policy.enabled && policy.reason).toContain('github.com/AdityaBelhekar/Sheep/releases');
  });

  it('updates an installed, signed build', () => {
    expect(updatePolicy({ packaged: true, signed: true })).toEqual({ enabled: true });
  });
});

describe('which release is newer', () => {
  it.each([
    ['0.1.1', '0.1.0', true],
    ['0.2.0', '0.1.9', true],
    ['1.0.0', '0.99.99', true],
    ['v0.10.0', '0.9.0', true],
    ['0.1.0', '0.1.0', false],
    ['0.1.0', '0.1.1', false],
    ['0.9.0', '0.10.0', false],
  ])('%s after %s: %s', (candidate, current, newer) => {
    expect(isNewer(candidate, current)).toBe(newer);
  });

  it('offers nothing whose version it cannot read', () => {
    for (const odd of ['', 'latest', '1.2', '1.2.3-beta.1', '9999999999.0.0.0', '../1.0.0']) {
      expect(isNewer(odd, '0.1.0'), odd).toBe(false);
    }
    expect(isNewer('1.0.0', 'not a version')).toBe(false);
  });
});
