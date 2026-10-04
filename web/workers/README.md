# Hosting the background clips (Cloudflare R2 + a tiny Worker)

The web version of Tilawat makes every video inside the visitor's browser, so each visitor
downloads the background footage. To keep that fast and free, the footage is pre-cut into short
8-second pieces (about 2 MB each at 1080p, 1 MB at 720p) and stored in **Cloudflare R2**, which
charges nothing for downloads. A small **Worker** (`clips-worker.js`) hands those files to browsers.

Why a Worker and not R2's own `r2.dev` link? Cloudflare says `r2.dev` addresses are rate-limited and
meant for testing only. A Worker on a free `*.workers.dev` address is the supported way
(free plan: 100,000 requests per day).

You do this once. It takes about 15 minutes. You need: a free Cloudflare account, Node.js
(already installed for Tilawat), and a terminal opened in the project folder (`Islam project`).

---

## 1. Create the bucket

1. Sign in at <https://dash.cloudflare.com>.
2. In the left menu click **R2 Object Storage**. If asked, turn R2 on (Cloudflare may ask for a
   card even for the free tier: 10 GB storage free, downloads always free. Our clips use about 0.2 GB).
3. Click **Create bucket**. Name it exactly `tilawat-clips`. Leave the other options as they are. Click **Create bucket**.

## 2. Make a key so your computer can upload

1. Still on the R2 page, click **Manage API tokens** (or **API** → **Manage API tokens**).
2. Click **Create API token** (an "Account API token" or "User API token" both work).
3. Permissions: **Object Read & Write**. Under "Specify bucket(s)" choose **tilawat-clips**.
4. Click **Create**. The next page shows several values **only once**. Keep it open.
5. Open the file `.env` in the project folder with Notepad and add these lines at the end
   (paste your own values after the `=`, no spaces, no quotes):

   ```
   R2_ACCOUNT_ID=          (the Account ID, 32 letters/digits; also shown on the R2 overview page)
   R2_ACCESS_KEY_ID=       (the "Access Key ID")
   R2_SECRET_ACCESS_KEY=   (the "Secret Access Key")
   R2_BUCKET=tilawat-clips
   ```
   Save the file. Never share it or put it on GitHub (it is already ignored by git).

## 3. Put the Worker online

In the terminal:

```
cd web/workers
npx wrangler login
```
A browser window opens: click **Allow**. Back in the terminal:

```
npx wrangler deploy
```
The first time, it may ask you to pick a `workers.dev` name for your account; choose anything.
At the end it prints an address like:

```
https://tilawat-clips.your-name.workers.dev
```
Copy it. Go back to the project folder:

```
cd ../..
```

## 4. Tell Tilawat where the clips live

Add one more line to `.env` (your own address, without a `/` at the end):

```
R2_PUBLIC_URL=https://tilawat-clips.your-name.workers.dev
```

## 5. Upload the clips

```
node scripts/build-web-clips.js
node scripts/upload-r2.js --dry-run
node scripts/upload-r2.js
```
- The first command makes the clip pieces (only needed if the folder `tmp/web-clips` is missing;
  it reuses what is already there, so it is quick the second time).
- `--dry-run` only checks your settings and shows what would be uploaded.
- The last command uploads (about 170 MB, a few minutes) and then rewrites `web/clips.json`
  so the website loads the clips from your Worker. Running it again only uploads what is missing.

It ends with a line like `Check: https://…/thumbs/40704.jpg → 200, CORS ok.` — that means it works.
Then rebuild/redeploy the website as usual (the site reads `web/clips.json`).

**Changed the Worker address later?** Update `R2_PUBLIC_URL` in `.env` and run
`node scripts/upload-r2.js --manifest-only` (rewrites `web/clips.json` without uploading anything).

---

## What the Worker does

- Serves only `segments/*.mp4` and `thumbs/*.jpg` from the bucket bound as `CLIPS`; anything else is 404.
- `GET`/`HEAD` only (plus the browser's CORS pre-check), `Access-Control-Allow-Origin: *`.
- Files never change, so it sends `Cache-Control: public, max-age=31536000, immutable`.
- Supports `Range` requests (seeking in a video) and `If-None-Match` (304).

## Troubleshooting

| Message | Fix |
|---|---|
| `no R2 settings found in .env` | Step 2: the four `R2_…` lines are missing or misspelled. |
| `HTTP 403 (check the R2 keys and bucket name)` | The token has no write access to this bucket, or a value was pasted with a space. Make a new token (step 2). |
| `wrangler deploy` says the bucket does not exist | The bucket name in `wrangler.toml` (`bucket_name`) and on Cloudflare must both be `tilawat-clips`. If you used another name, change `bucket_name` and `R2_BUCKET` to match. |
| `Warning: … no "Access-Control-Allow-Origin: *"` | `R2_PUBLIC_URL` points somewhere other than the Worker (e.g. an `r2.dev` link). Use the `workers.dev` address from step 3. |
