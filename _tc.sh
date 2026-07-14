#!/usr/bin/env bash
export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"
cd "$HOME/campsite-finder"
node ./node_modules/typescript/bin/tsc --noEmit 2>&1 | head -40
echo "EXIT=${PIPESTATUS[0]}"
