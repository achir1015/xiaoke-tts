#!/bin/bash
# 把網頁（和線上版同一份）複製到 ios/web，再產生 Xcode 專案。在 Mac 上執行：bash sync.sh
set -e
cd "$(dirname "$0")"
rm -rf web && mkdir web
cp ../index.html ../version.json ../manifest.webmanifest ../favicon-32.png ../favicon-16.png ../apple-touch-icon.png web/
cp -R ../css ../js ../vendor ../icons ../voices ../samples web/
rm -f web/icons/app.ico web/icons/icon-1024.png
V=$(python3 -c 'import json;print(json.load(open("../version.json"))["version"])')
sed -i '' "s/MARKETING_VERSION: \".*\"/MARKETING_VERSION: \"$V\"/" project.yml
/usr/local/bin/xcodegen generate --quiet
echo "web ok, version $V"
