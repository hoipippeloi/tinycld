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
