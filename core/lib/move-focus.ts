import { AccessibilityInfo, type HostInstance, Platform } from 'react-native'

/**
 * Moves focus to a control after the UI changed under it (a row moved, a row
 * removed). On web that is DOM focus, which keyboard and screen-reader users
 * share. On native `focus()` does nothing on a non-text view, so the screen
 * reader's cursor (VoiceOver, TalkBack) is moved instead.
 */
export function moveFocus(target: HostInstance) {
    if (Platform.OS === 'web') {
        target.focus()
        return
    }
    AccessibilityInfo.sendAccessibilityEvent(target, 'focus')
}
