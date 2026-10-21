---
title: App passwords
summary: Give mail, calendar, contacts and file apps their own password, so they keep working with two-step verification on
tags: [security, app password, imap, smtp, caldav, carddav, webdav, mfa]
order: 28
---

Apps that connect directly to this server, such as Apple Mail, Thunderbird, DAVx⁵ or a file manager, cannot ask for a two-step verification code. An app password is a password just for one of these apps.

When [two-step verification](help://core:security-mfa) is on, or your organization requires it, your account password no longer works in these apps. Use an app password instead.

## Create an app password

1. Open **Settings → Security**.
2. In **App passwords**, select **Create an app password**.
3. Type a name for the app or device, such as "Thunderbird on my laptop", and select **Create**.
4. Copy the password and type it into the app where it asks for your password. As the user name, use your username or an email address this server hosts for you.

You see the password one time only. If you lose it, revoke it and create a new one.

Spaces in the app password are optional, and so are capital letters.

## Revoke an app password

In **Settings → Security**, select the bin next to the app password, then **Revoke**. The app stops signing in at once. Revoke an app password when you stop using the app or lose the device.

All your app passwords are revoked when you change your password, when an admin sets a temporary password for you, and when an admin resets your two-step verification. Create new ones for your apps after that.
