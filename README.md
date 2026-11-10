# iNaturalist 觀察地圖（澳門）

線上版（Netlify）：<https://resplendent-alpaca-f1f9f2.netlify.app/>  
GitHub Pages 預覽：<https://nataliechan27-lab.github.io/inaturalist-waisan2/>

以 Leaflet 建立的可互動生物多樣性地圖，資料來自 iNaturalist 公開 API，只顯示 **research grade** 觀察。預設載入 `@waisan2` 的內建快照，也可輸入其他公開帳號即時載入。

## 功能

- 高德街道圖／衛星圖，支援 WGS84 → GCJ-02 座標校正
- 滑鼠懸停或觸控點擊顯示 large 相片卡
- 依分類群分組的相片牆與燈箱
- 搜尋、分類篩選、排序、GPS 精度圈
- 月份 × 類群熱圖、綱／目／科 treemap，點擊可篩選地圖
- CSV／GeoJSON 匯出、分享連結
- 手動「更新資料」，不自動輪詢
- 觀察資料與分類快取於瀏覽器 `localStorage`

## 檔案

部署需要以下檔案：

- `index.html`
- `app.js`
- `snapshot.js`
- `gcj-region.js`（判斷高德 GCJ-02 適用範圍）
- `vendor/leaflet/`（本地 Leaflet，避免 CDN 失效）
- `.nojekyll`（避免 GitHub Pages 執行 Jekyll）

## 更新網站

在原始專案資料夾執行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\build_site.ps1
```

這會重建 `dist/`（保留 `.git`），然後在 `dist/` 內：

```powershell
git add -A
git commit -m "Update map"
git push
```

GitHub Pages 會自動重新發布。

## Netlify 更新

若網站是手動上傳到 Netlify，可在 Netlify 網站後台用 **Deploys → Drag and drop** 上傳重建後的 `dist/` 資料夾；這會保留同一個網址。也可以把 GitHub repo 連到 Netlify，之後每次 push 自動部署。

這個網站的 Netlify site ID 是 `ec38d009-cf86-4b5d-af68-b887870af8e6`。若要用 CLI 更新同一個網站：

```powershell
npx --yes netlify-cli@latest login
npx --yes netlify-cli@latest link --id ec38d009-cf86-4b5d-af68-b887870af8e6
npx --yes netlify-cli@latest deploy --prod --dir=dist
```

## 注意

- 高德在中國大陸、香港、澳門、台灣使用 GCJ-02，海外使用 WGS84；`gcj-region.js` 會依每筆觀察自動判斷。切換「淺色底圖」（CARTO／OSM）時一律使用 WGS84。
- 高德圖磚使用公開端點，公開網域可能受 referer 限制；若底圖空白，可切換「淺色底圖」，或改用正式高德 JS API Key。
- 分享連結與剪貼簿功能需要 HTTPS；GitHub Pages 與 Netlify 均提供 HTTPS。
- iNaturalist 觀察與照片依其原授權提供，使用時請保留作者與 iNaturalist 出處連結。
