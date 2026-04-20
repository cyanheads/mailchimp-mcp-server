# Generating a Mailchimp API key

The server authenticates with a single Mailchimp Marketing API key, passed via the `MAILCHIMP_API_KEY` environment variable. The key has the form `<32-hex>-<dc>` (e.g. `abc…xyz-us22`); the `-dc` suffix identifies your account's data center and is parsed at startup to derive the API host.

## Steps

1. Click your profile icon and choose **Profile**.
2. Click the **Extras** drop-down then choose **API keys**.
3. In the **Your API Keys** section, click **Create A Key**.
4. Name your key. Be descriptive, so you know what app uses that key. Keep in mind that you'll see only this name and the first 4 key digits on your list of API keys.
5. Click **Generate Key**.
6. Once we generate your key, click **Copy Key to Clipboard**. Save your key someplace secure — you won't be able to see or copy it again. If you lose this key, you'll need to generate a new key and update any integration that uses it.
7. Click **Done**.

## Using the key

Paste the key (including the `-dc` suffix) into your environment:

```bash
export MAILCHIMP_API_KEY="abcdef0123456789abcdef0123456789-us22"
```

Or into `.env` (see `.env.example` for the full list of optional overrides).

## Required permissions

The key inherits the permissions of the user it was generated under. For full coverage of this server's tool surface, that user should have **Manager** permissions or above on the account. **Viewer**-only keys will succeed on read operations but 403 on any create/update/send call.
