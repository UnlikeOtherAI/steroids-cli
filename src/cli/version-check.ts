/**
 * Check for new versions of steroids-cli on npm
 */

import { execSync } from 'node:child_process';

let versionCheckShown = false;

/**
 * Check if a newer version is available on npm
 * Uses npm view to check latest version (fast, cached by npm)
 */
export async function checkForNewVersion(currentVersion: string): Promise<void> {
  // Only check once per process
  if (versionCheckShown) return;
  versionCheckShown = true;

  try {
    // Use npm view with timeout (fail fast if offline)
    const latestVersion = execSync('npm view steroids-cli version', {
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe'], // Don't show errors
    }).trim();

    if (latestVersion && latestVersion !== currentVersion) {
      console.error('');
      console.error('\x1b[33m⚠️  There is a new version available. Please update because I am a knob and probably figured something didn\'t work, @rafiki270 :)\x1b[0m');
      console.error(`   Current: v${currentVersion}`);
      console.error(`   Latest:  v${latestVersion}`);
      console.error('');
      console.error('   Update with: \x1b[36mnpm install -g steroids-cli@latest\x1b[0m');
      console.error('');
    }
  } catch {
    // Silently ignore errors (offline, npm not available, timeout, etc.)
  }
}
