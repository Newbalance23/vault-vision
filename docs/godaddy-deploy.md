# GoDaddy Deployment

Vault Vision V1 is best deployed as a static website on GoDaddy, with Supabase providing the backend. This keeps hosting simple and lets ordinary GoDaddy web hosting serve the app.

## 1. Configure Supabase

1. Create a Supabase project.
2. Run `docs/supabase-schema.sql` in the Supabase SQL editor.
3. In Supabase Auth settings, add your GoDaddy domain to the allowed site URL / redirect URLs.
4. Copy the project URL and anon/public key.

## 2. Add Production Config

Edit `src/config.js`:

```js
export const DEFAULT_SUPABASE_CONFIG = {
  url: "https://YOUR_PROJECT.supabase.co",
  anonKey: "YOUR_SUPABASE_ANON_KEY",
};
```

The anon key is public by design. The database and storage policies in `docs/supabase-schema.sql` are what protect user data.

## 3. Upload to GoDaddy

Upload these files and folders to your GoDaddy site root, usually `public_html`:

```text
index.html
README.md
src/
docs/
tests/
package.json
```

Only `index.html` and `src/` are required for visitors. Keeping `docs/` online is optional.

## 4. Test the Live Site

1. Visit your GoDaddy domain over HTTPS.
2. Create an account.
3. Load a short pole vault video.
4. Run analysis and confirm the skeleton overlay appears with green/yellow/red form colors.
5. Save the analysis and refresh the page to confirm it appears in the saved session library.

## When to Move Beyond Static

A non-static app becomes useful when you want server-side video processing, paid subscriptions, coach/team admin tools, or custom AI model training. For this V1, static hosting plus Supabase is the simplest path to a usable public product.
