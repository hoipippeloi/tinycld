/**
 * The user closed the browser sheet, or chose "Back to the app" on the page.
 * Its own module so web code can recognize it without loading the native
 * browser-sheet code.
 */
export class NativeAuthCancelled extends Error {
    constructor() {
        super('Sign-in was cancelled')
        this.name = 'NativeAuthCancelled'
    }
}

/**
 * The sheet replaced an admin-set temporary password instead of signing in.
 * The app asks the user to sign in again with the new password.
 */
export class NativeAuthPasswordChanged extends Error {
    constructor() {
        super('Your new password is set. Sign in with it.')
        this.name = 'NativeAuthPasswordChanged'
    }
}
