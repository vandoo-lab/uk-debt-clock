#!/bin/zsh
# Asks for the Cloudflare analytics key in a pop-up and saves it to the macOS Keychain.
# The key never leaves this script and is not printed.
KEY=$(osascript -e 'text returned of (display dialog "Paste the Cloudflare analytics key (from the Account API tokens page), then click Save." default answer "" with hidden answer with title "UK Debt Clock" buttons {"Cancel", "Save"} default button "Save")') || { echo "Cancelled."; exit 1; }
KEY=${KEY//[[:space:]]/}
if [ -z "$KEY" ]; then echo "No key entered."; exit 1; fi
security add-generic-password -U -a cloudflare-analytics -s uk-debt-clock-cf-analytics \
  -l "UK Debt Clock - Cloudflare analytics read token" -w "$KEY" && echo "Saved to Keychain."
unset KEY
