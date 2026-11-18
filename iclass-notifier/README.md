# 北護 iClass 通知小幫手

iClass 有新公告、教材、作業或測驗時傳 LINE 通知你；有截止日的自動加進 Google 日曆，並在到期前 24 小時用 LINE 提醒。
全部跑在 **Google Apps Script（GAS）**：免費，電腦不用開著。

```
iClass ──寄信──▶ 學校 WebMail ──自動轉寄──▶ 你的 Gmail ──┐
                                                         ├─▶ Apps Script ─┬─▶ LINE 推播
iClass 網頁 ◀──（用你的 Cookie 每 15 分鐘看一次）────────┘                ├─▶ Google 日曆（24 小時前、1 小時前跳出提醒）
                                                                           └─▶ 到期前 24 小時 LINE 提醒
```

| | 方案 A：通知信（主） | 方案 B：iClass 網頁（輔） |
|---|---|---|
| 來源 | 轉寄到 Gmail 的 iClass 通知信 | 用你的瀏覽器 Cookie 讀 iClass 頁面 |
| 頻率 | 每 5 分鐘 | 每 15 分鐘 |
| 要維護嗎 | 不用 | Cookie 失效時要重新貼（會用 LINE 通知你） |
| 會鎖帳號嗎 | 不會（不碰 iClass） | 不會（程式從來不輸入帳密，只用你已登入的 Cookie） |

B 不填 Cookie 也沒關係，A 一樣會正常運作。

> **先知道的兩件事（從北護 iClass 網站上查到的）：**
> 1. 北護 iClass 是旭聯（FormosaSoft）的系統，不是 TronClass；登入頁有 6 位數字驗證碼，所以不可能做「全自動登入」。B 才會改用 Cookie。
> 2. iClass 首頁公告：「Gmail 會阻擋 iClass 寄出的信件，iClass 信件將改寄至學校 WebMail」。所以要在學校 WebMail 設定**自動轉寄到 Gmail（勾選保留副本）**。程式會連垃圾郵件匣一起找。萬一轉寄被 Gmail 擋掉，B 就是你的備援。

---

## 步驟 1：學校 WebMail 自動轉寄到 Gmail

1. 登入 [學校 WebMail](https://webmail.ntunhs.edu.tw/)（Openfind Mail2000）。登不進去請洽電算網路組，分機 2226。
2. 到「設定／個人設定」裡找「自動轉寄」，轉寄地址填你的 Gmail，**一定要勾「保留副本」**。
3. 到 iClass 的「個人設定／通知設定」，確認公告、教材、作業、測驗的 Email 通知都有開。
4. 等收到第一封轉寄過來的 iClass 信後，在 Gmail 點信件右上角「⋮ → 篩選這類郵件」，勾**「一律不要將它傳送到垃圾郵件」**，然後建立篩選器。

## 步驟 2：建立 LINE Messaging API

1. 到 <https://developers.line.biz/console/> 用你的 LINE 帳號登入。
2. **Create a new provider**，名字隨便取，例如 `my-iclass`。
3. 建立 **Messaging API** channel。新版介面會先請你建立一個「LINE 官方帳號」，照畫面做就好。
4. 在 channel 的 **Basic settings** 頁最下方，複製 **Your user ID**（`U` 開頭）→ 這是 `LINE_USER_ID`。
5. 在 **Messaging API** 分頁最下方，按 **Channel access token (long-lived) → Issue** → 這是 `LINE_CHANNEL_ACCESS_TOKEN`。
6. 用手機掃同一頁的 QR code，**把官方帳號加為好友**。沒加就收不到。
7. （建議）到 LINE Official Account Manager 把「自動回應訊息」關掉，避免你傳訊息給它時它亂回。

> 免費方案每月 200 則推播。程式會把同一次檢查的多件事合併成 1 則，還會記錄每月用量，到 200 則就自動停止推播，所以不會被收費。

## 步驟 3：建立 Apps Script 專案

1. 用**接收轉寄信的那個 Gmail 帳號**打開 <https://script.google.com/> → **新專案**，把專案改名為「iClass 通知」。
2. 把 `Code.gs` 的內容整個貼進編輯器的 `程式碼.gs`（原本的內容要刪掉），按儲存。
3. 左側 ⚙️「專案設定」：
   - 勾選 **「在編輯器中顯示 appsscript.json 資訊清單檔案」**，回到編輯器，打開 `appsscript.json`，換成本資料夾的 `appsscript.json`（這樣時區才會是 `Asia/Taipei`）。
   - 下方 **「指令碼屬性」→ 新增**：

| 屬性 | 值 | 必填 |
|---|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | 步驟 2-5 的 token | ✅ |
| `LINE_USER_ID` | 步驟 2-4 的 `U...` | ✅ |
| `ICLASS_COOKIE` | 步驟 5 的 Cookie | 選填（B） |
| `GMAIL_QUERY` | 自訂 Gmail 搜尋條件（見「調整」） | 選填 |
| `ICLASS_PAGES` | B 要看的頁面，逗號分隔，預設 `/dashboard` | 選填 |

> Token 和 Cookie 只存在你自己的指令碼屬性裡，不會出現在程式碼中。**不要貼到聊天或任何公開的地方。**

## 步驟 4：第一次執行

1. 上方函式選單選 **`setup`** → **執行**。
2. 會跳出授權視窗：選你的帳號，看到「Google 尚未驗證這個應用程式」時按 **進階 → 前往 iClass 通知（不安全）→ 允許**。這是你自己寫的程式，不是別人的程式，所以會有這個提示。
3. LINE 收到「✅ iClass 通知小幫手設定完成」就成功了。Google 日曆也會多出一個「iClass 作業」日曆。
4. 選 **`debugRecentMails`** → 執行，看「執行紀錄」：會列出最近 30 天找到的 iClass 信，以及程式判斷出的類型和截止日。
   - 找不到信 → 檢查轉寄有沒有設好，或調整 `GMAIL_QUERY`。
   - 截止日抓錯 → 把那封信的主旨和內文（遮掉個資）給我，我幫你調整解析規則。

## 步驟 5（選填，B）：取得 iClass Cookie

1. 用電腦的 Chrome 登入 iClass，進入首頁或儀表板。
2. 按 **F12** → **Network（網路）** 分頁 → 按 **F5** 重新整理。
3. 點清單最上面那一筆（例如 `dashboard`）→ 右邊 **Headers** → **Request Headers** → 找到 **`Cookie:`**，複製**冒號後面的整串**。
4. 貼到指令碼屬性 `ICLASS_COOKIE`。
5. 執行 **`debugWebPage`**，看執行紀錄：
   - `✅ 已登入`，下面列出作業、公告等項目 → 成功。B 第一次跑時只會記下現有的項目，之後有新的才通知。
   - `❌ Cookie 無效／過期` → 重新複製一次 Cookie。
   - 已登入但「找到 0 個項目」→ 首頁可能沒有列出作業。打開 iClass 裡有列出作業或待辦的頁面，把網址的路徑部分（例如 `/user/calendar`）填進 `ICLASS_PAGES`。

**Cookie 會失效**：登出、閒置太久，或在別的裝置重新登入都可能讓它失效。失效時 LINE 會通知你**一次**，重新貼上就好，A 不受影響。

---

## 日常使用

- **完成作業**：在 Google 日曆把那個活動的標題前面加上 `✅`，就不會再收到 LINE 到期提醒。直接刪掉活動也可以。
- **截止日標示「推測」**：通知信裡沒有明寫「截止」，程式是從信中的日期推測的，請點連結確認。如果 B 之後從網頁抓到精確時間，會自動更新日曆並通知你。
- **只想看日曆、不要 LINE 到期提醒**：在 GAS「觸發條件」刪掉 `checkUpcoming`。

## 調整

所有預設值都在 `Code.gs` 最上方的 `CONFIG`：

| 設定 | 預設 | 說明 |
|---|---|---|
| `GMAIL_QUERY` | `in:anywhere -in:trash {from:iclass subject:iclass "iClass"}` | 找通知信的條件。知道寄件者地址後，建議改成 `in:anywhere -in:trash from:寄件者地址`，比較精準 |
| `CALENDAR_POPUP_MINUTES` | `[1440, 60]` | 日曆跳出提醒，單位是分鐘 |
| `LINE_REMIND_HOURS` | `24` | 到期前幾小時傳 LINE |
| `DEFAULT_DUE_TIME` | `23:59` | 信裡只寫日期沒寫時間時用的時間 |

## 排程與額度

| 函式 | 頻率 | 做什麼 |
|---|---|---|
| `processMail` | 每 5 分鐘 | A：讀新信 → LINE + 日曆 |
| `checkWeb` | 每 15 分鐘 | B：看 iClass 網頁（沒填 Cookie 就直接跳過） |
| `checkUpcoming` | 每小時 | 24 小時內到期的項目 → LINE |

這些都在 Google 免費帳號的額度內（每天觸發執行時間上限 90 分鐘，本工具大約用 15～25 分鐘）。

## 疑難排解

| 狀況 | 怎麼辦 |
|---|---|
| 沒收到任何 LINE | 執行 `testLine`。如果出現 HTTP 401，就是 token 錯了；400 通常是 User ID 錯，或還沒加官方帳號好友 |
| 收到通知信但沒有 LINE | 執行 `debugRecentMails`，看信有沒有被搜尋到 |
| 同一件事通知兩次 | A 和 B 會用標題比對來去重。比對不到的話，把兩則訊息的內容給我 |
| 想重設 | 在指令碼屬性刪掉 `PROCESSED_IDS`、`WEB_SEEN`，再執行一次 `setup` |

## 開發

解析邏輯（日期、分類、網頁擷取）不依賴 GAS，可以在本機測試：

```bash
TZ=Asia/Taipei node iclass-notifier/test/parser.test.js
```
