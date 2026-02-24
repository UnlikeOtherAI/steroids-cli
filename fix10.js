import fs from 'fs';

let content = fs.readFileSync('tests/credit-pause.test.ts', 'utf-8');

// Replace project mock
content = content.replace(/const mockSetProjectHibernation = jest\.fn\(\);

jest\.unstable_mockModule\('\.\.\/src\/runners\/projects\.js', \(\) => \(\{
  getRegisteredProject: mockGetRegisteredProject,
  setProjectHibernation: mockSetProjectHibernation,
  clearProjectHibernation: jest\.fn\(\),
\}\)\);
/, '');

// Add global-db mock
content = content.replace(/const mockGetRegisteredProject = jest\.fn\(\);/, 'const mockRecordProviderBackoff = jest.fn();
const mockGetProviderBackoffRemainingMs = jest.fn().mockReturnValue(0);

jest.unstable_mockModule('../src/runners/global-db.js', () => ({
  recordProviderBackoff: mockRecordProviderBackoff,
  getProviderBackoffRemainingMs: mockGetProviderBackoffRemainingMs,
}));');

// Test 1 replacement
content = content.replace(/mockGetRegisteredProject\.mockReturnValue\(\{ hibernation_tier: 0 \}\);/, 'mockGetProviderBackoffRemainingMs.mockReturnValue(0);');
content = content.replace(/expect\(mockSetProjectHibernation\)\.toHaveBeenCalledWith\([\s\S]*?\);/, 'expect(mockRecordProviderBackoff).toHaveBeenCalledWith(
        'claude',
        now + 5 * 60 * 1000,
        expect.any(String),
        'capacity_exhaustion'
      );');
content = content.replace(/'sets project hibernation to tier 1 \(5 minutes\) initially'/, ''sets provider backoff to 5 minutes initially'');

// Test 2 replacement
content = content.replace(/mockGetRegisteredProject\.mockReturnValue\(\{ hibernation_tier: 1 \}\);/, 'mockGetProviderBackoffRemainingMs.mockReturnValue(1);');
content = content.replace(/expect\(mockSetProjectHibernation\)\.toHaveBeenCalledWith\([\s\S]*?\);/, 'expect(mockRecordProviderBackoff).toHaveBeenCalledWith(
        'claude',
        now + 30 * 60 * 1000,
        expect.any(String),
        'capacity_exhaustion'
      );');
content = content.replace(/'sets project hibernation to tier 2\+ \(30 minutes\) on subsequent failures'/, ''sets provider backoff to 30 minutes on subsequent failures'');

fs.writeFileSync('tests/credit-pause.test.ts', content);