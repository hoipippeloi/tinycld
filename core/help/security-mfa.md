---
title: Two-step verification
summary: Protect your account with a code from an authenticator app, and keep recovery codes for when you lose your phone
tags: [security, mfa, 2fa, two-factor, totp, authenticator, recovery codes]
order: 26
---

With two-step verification on, signing in needs your password **and** a second step: a 6-digit code from an authenticator app on your phone, or a [passkey](help://core:security-passkeys).

## Turn on two-step verification

1. Open **Settings → Security**.
2. In **Authenticator app**, select **Set up an authenticator app**.
3. Scan the QR code with an authenticator app, such as Google Authenticator, 1Password or Authy. If you cannot scan it, type the key shown below the code into the app.
4. Type the 6-digit code that the app shows, then select **Turn on**.
5. Save the 10 recovery codes. You will not see them again.

The authenticator app labels the entry with this server's address (`{{server-host}}`), so you can tell servers apart.

## Sign in with two-step verification

1. Type your username or email and your password, as usual.
2. Type the 6-digit code from your authenticator app and select **Verify**.

Each code works one time. If a code is refused, wait for the next one.

## If you lose your phone

On the code screen, select **Use a recovery code** and type one of your saved recovery codes. Each recovery code works one time. After you sign in, open **Settings → Security** and set up the app again on your new phone.

If you have no recovery codes left, ask an owner or admin of your organization to reset your two-step verification. They can do this from **Settings → Members**.

## Make new recovery codes

In **Settings → Security**, select **New recovery codes** and type a code from your authenticator app. Your old recovery codes stop working.

## Mail, calendar and contacts apps

Apps such as Apple Mail, Thunderbird and DAVx⁵ cannot ask for a code. When two-step verification is on, your account password no longer works in them. Give each app its own [app password](help://core:security-app-passwords).

## When your organization requires it

An owner or admin can require two-step verification for everyone in **Settings → Sign-in security**. If you have not set it up, the next sign-in asks you to set up an authenticator app or a passkey before you can continue.

Guests who open a shared file or board with a code sent by email are not asked for a second step. A member with two-step verification on, or any member while it is required, cannot open a shared link with an emailed code: sign in to TinyCld first, then open the link.
