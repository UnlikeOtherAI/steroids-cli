# Claude SSH Auth Debug

## Problem

Claude Code was intermittently failing over SSH and other non-GUI shells with:

- `401 authentication_error`
- `OAuth token has expired`

This happened even when:

- `HOME` was correct
- `claude auth status` reported `loggedIn: true`
- provider discovery and project config tests passed

## Root Cause

Claude was using the first-party browser OAuth refresh path, which depended on reading the `Claude Code-credentials` secret from the macOS login keychain.

In SSH/background shells, `securityd` could not complete the secret read interactively and logged:

- `SecKeychainItemCopyContent`
- `unlocking for makeUnlocked()`
- `CSSMERR_CSP_NO_USER_INTERACTION`
- `denying access`

So the real failure was not repo config and not `HOME`. It was macOS refusing a non-interactive keychain secret read during token refresh.

## What Did Not Work

- Relying on `claude auth status`
  - It only showed metadata; it did not prove the secret was readable.
- Relying on `steroids ai providers` or `steroids ai test reviewer`
  - They proved provider discovery/config, not end-to-end Claude auth.
- Trusting login keychain `no-timeout`
  - The keychain was still able to deny non-interactive secret reads.
- `security unlock-keychain` as the fix
  - It worked temporarily, but it did not address the SSH/non-GUI failure mode.

## What Worked

Move Claude off the keychain-dependent OAuth refresh path and onto a long-lived token path:

1. Run `claude setup-token`
2. Store the resulting token outside the keychain in:
   - `~/.config/claude-code/oauth-token`
3. Lock the file down:
   - mode `0600`
4. Export it for all shells from:
   - `~/.zshenv`

Installed export:

```zsh
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -r "$HOME/.config/claude-code/oauth-token" ]; then
  export CLAUDE_CODE_OAUTH_TOKEN="$(<"$HOME/.config/claude-code/oauth-token")"
fi
```

## Verification

After switching to `CLAUDE_CODE_OAUTH_TOKEN`:

- the login keychain was deliberately locked
- direct secret read still failed:
  - `security find-generic-password -s 'Claude Code-credentials' -w ...`
- a fresh shell still succeeded:
  - `claude -d api -p "say hi"`

That proved Claude no longer depended on the login keychain for SSH use.

## Files Added/Changed

- `~/.config/claude-code/oauth-token`
- `~/.zshenv`
- `~/claude-ssh-auth-debug.md`
- `docs/done/2026-03-26-claude-ssh-auth-debug.md`

## Operational Notes

- Do not put the long-lived token value into docs, shell history, or repo files.
- New shells pick up the fix automatically from `~/.zshenv`.
- Existing shells may need `exec zsh -l` or reconnecting.
