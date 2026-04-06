# DraftBridge Landing Site

Static single-page site for **draftbridgehq.com**.

## Local preview

```sh
cd site
python3 -m http.server 8080
# Open http://localhost:8080
```

## Deployment to Cloudflare Pages

1. In the Cloudflare dashboard, go to **Workers & Pages > Create**.
2. Choose **Pages > Upload assets**.
3. Upload the contents of this `site/` directory.
4. Set the custom domain to `draftbridgehq.com` (or `www.draftbridgehq.com`).
5. Cloudflare will handle SSL and CDN automatically.

Alternatively, connect a Git-based deployment:

1. Go to **Workers & Pages > Create > Connect to Git**.
2. Select the `ahmadkhatib104/draftbridge` repo.
3. Set the build output directory to `site`.
4. Leave the build command empty (static files, no build step).
5. Deploy.

## Form handling

The CTA form at `#book-pilot` uses `data-netlify="true"` as a placeholder.
For Cloudflare Pages, replace with one of:

- **Cloudflare Workers** — create a Worker that receives the form POST and
  forwards it to your email or a CRM webhook.
- **Formspree** — change the form action to your Formspree endpoint.
- **Email** — simplest option: change the form to `mailto:support@draftbridgehq.com`.

## Files

- `index.html` — the single landing page
- `style.css` — all styles (dark theme, responsive)
