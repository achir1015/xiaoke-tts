# 小柯機器人台灣語音 MP3 工具

用 [IndexTTS](https://github.com/index-tts/index-tts) 產生台灣口音的 MP3。打開網頁就能用：不用安裝、不用執行命令列，語音引擎和素材會自動準備好；關掉網頁就停止。

## 功能

- **單一語音**：文字 → MP3；可調情緒、強度、語速、音質；可疊背景音樂、環境音，加 MP3 封面
- **劇本語音（多人）**：一人說、多人同時說（【同時】）、搶話（`>`）、停頓；立體聲左右位置、空間感
- **自然環境音（即時合成）**：雨聲、大雨、雷雨、風聲、海浪、溪流、鳥叫、森林、蟲鳴、蟬鳴、夜晚、營火、菜市場、人群、會議廳、咖啡廳
- **音效**：雷聲、遠雷、鳥叫、蟲鳴、蛙叫、門鈴、敲門、電話鈴、掌聲、腳步聲、鐘聲、水滴、風聲
- **聲音範本**：13 種內建台灣口音聲音（名稱＝檔名，標示年齡、性別）；每種都可以錄音或上傳替換，也可以新增自訂聲音
- **專案素材**：聲音 mp3、文案、圖形、背景音樂、音效。電腦版 Chrome／Edge 可以直接連結專案資料夾（產生的 MP3 自動存到「輸出」）
- **小說轉劇本**、台詞快取（改劇本只重做有變的句子）、產生紀錄
- **網址列小圖示、加到桌面／主畫面**（PWA）

## 下載

| 版本 | 取得方式 |
|---|---|
| 線上網頁版（任何瀏覽器、手機可加入主畫面） | https://achir1015.github.io/xiaoke-tts/ |
| Windows 10／11 | [Releases](https://github.com/achir1015/xiaoke-tts/releases/latest) 的 `XiaokeTTS-Setup-版本.exe` |
| Mac（Apple 晶片／Intel） | Releases 的 `XiaokeTTS-mac-AppleSilicon／Intel-版本.dmg` |
| Android 8 以上 | Releases 的 `XiaokeTTS-Android-版本.apk` |
| iPhone／iPad | `ios/` 用 Xcode 在 Mac 上編譯安裝（或用線上版加入主畫面） |

所有版本都是同一份網頁：打開就能用、語音引擎自動連線；關掉視窗或 App 就完全結束。App 版產生的 MP3 自動存到「音樂／小柯語音」。

## 語音引擎

| 引擎 | 說明 |
|---|---|
| 雲端 IndexTTS-2.5（預設） | IndexTeam 官方 Hugging Face 示範空間。沒登入只能用幾次，在「設定」貼上免費的 Hugging Face 權杖即可繼續用 |
| 雲端 IndexTTS-2（備用） | 主引擎連不到時自動改用 |
| 自架伺服器（進階） | [indextts2-taiwan-tts](https://github.com/achir1015/indextts2-taiwan-tts)，可用台語 |

## 專案資料夾

```
我的專案/
  專案設定.json
  聲音/  文案/  圖形/  背景音樂/  音效/  輸出/
```

## 開發

純 ES modules 靜態網頁，不需編譯。

- 圖示：`python tools/make_icons.py`（網頁、Windows .ico、Android、iPhone 一次產生）
- 內建聲音：`python tools/sync_voices.py`（從 indextts2-taiwan-tts 抓檔名有年齡、性別的 mp3）
- 發佈：改 `version.json`（版本與更新內容）、`js/version.js`、`sw.js` 快取名稱 → 推 main，GitHub Actions 自動打包 Windows／Mac 並建立 Release
- 桌面版：`desktop/app.py`（pywebview：Windows＝WebView2、Mac＝Qt WebEngine），`desktop/app.py --selftest 報告.json` 自我測試
- Android：`python android/build.py`（不用 Gradle；需要 JDK 17、Android SDK）。發佈時 GitHub Actions 用 repo Secret `ANDROID_KEYSTORE_B64`（簽章金鑰）自動建置並附上 APK
- iPhone：在 Mac 上 `bash ios/sync.sh` 產生 Xcode 專案（需要 xcodegen）

## 授權與致謝

- 語音模型：IndexTTS（bilibili，請遵守其模型授權）
- 聲音樣本：indextts2-taiwan-tts（Common Voice 台灣華語 CC0、TaigiSpeech CC BY 4.0）
- MP3 編碼：lamejs（LGPL）
- 請勿用本工具冒充特定真人的聲音
