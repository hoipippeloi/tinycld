import { useAuth } from '@tinycld/core/lib/auth'
import { useOrgHref } from '@tinycld/core/lib/org-routes'
import { switchUrlFor } from '@tinycld/core/lib/server-handoff'
import { canSwitchInPlace, isSameServer, type SavedServer } from '@tinycld/core/lib/servers'
import { useToastStore } from '@tinycld/core/lib/stores/toast-store'
import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { useSavedServers } from '@tinycld/core/lib/use-saved-servers'
import { ConfirmDialog } from '@tinycld/core/ui/ConfirmDialog'
import { Menu } from '@tinycld/core/ui/menu'
import { useRouter } from 'expo-router'
import { LogOut, Server, Settings, Trash2, User } from 'lucide-react-native'
import { useState } from 'react'
import { Pressable, Text } from 'react-native'

export function UserMenu() {
    const railActiveText = useThemeColor('rail-active-text')
    const { user, logout } = useAuth()
    const orgHref = useOrgHref()
    const router = useRouter()
    const servers = useServerSwitcher()

    return (
        <>
            <Menu
                trigger={
                    <Pressable
                        className="size-8 rounded-full justify-center items-center"
                        style={{
                            backgroundColor: 'rgba(255,255,255,0.15)',
                        }}
                        accessibilityLabel="User menu"
                    >
                        <User size={20} color={railActiveText} />
                    </Pressable>
                }
                placement="top-start"
                title={user.name}
            >
                <Menu.Custom className="px-3 py-2">
                    <Text className="text-base font-bold text-foreground">{user.name}</Text>
                </Menu.Custom>

                <Menu.Separator />

                {/* The settings HUB, not the personal page: a generic
                "Settings" label must reach every section. Rules, Members
                and the rest are only listed on the hub, and on a tablet
                (>=768dp, see the note below) this menu is the sole
                Settings affordance — MoreDrawer never mounts. */}
                <Menu.Item
                    label="Settings"
                    icon={Settings}
                    onSelect={() => router.push(orgHref('settings'))}
                />

                <ServersSection switcher={servers} />

                <Menu.Separator />

                <Menu.Item label="Sign out" icon={LogOut} onSelect={logout} />
            </Menu>
            <RemoveServerConfirm switcher={servers} />
        </>
    )
}

// useServerSwitcher holds the saved-server state for the menu. It lives above
// the Menu because a chosen row closes the menu, and the remove confirmation
// must outlive that.
function useServerSwitcher() {
    const saved = useSavedServers()
    const [pendingRemoval, setPendingRemoval] = useState<SavedServer | null>(null)
    const activeOrigin = saved.activeOrigin ?? ''
    const others = saved.servers.filter(server => !isSameServer(server.origin, activeOrigin))

    // A menu item closes the popover on press, so unlike the drawer there is no
    // inline surface left to report a refused switch on — and switchToServer only
    // returns on FAILURE. Announce the outcome as a toast instead: ToastRenderer
    // sits in Providers at zIndex 10000, above the menu portal. In a dev build
    // every switch is refused, so say so up front rather than after the tap.
    //
    // Only meaningful where a switch happens in place. On web `switchTo` navigates
    // to the target origin, so there is no reload to be unavailable and the toast
    // would be both wrong and instantly discarded by the page load.
    function switchTo(origin: string) {
        if (canSwitchInPlace() && !saved.canReload) {
            useToastStore.getState().addToast({
                title: 'Restart to finish switching',
                body: 'This build cannot restart itself. Your choice is saved — reopen the app to land on it.',
                variant: 'warning',
                duration: 6000,
            })
        }
        saved.switchTo(origin)
    }

    async function confirmRemoval() {
        if (!pendingRemoval) return
        const error = await saved.remove(pendingRemoval.origin)
        setPendingRemoval(null)
        if (!error) return
        useToastStore.getState().addToast({ title: error, variant: 'error', duration: 6000 })
    }

    return {
        servers: saved.servers,
        others,
        activeOrigin,
        isBusy: !!saved.busyOrigin,
        pendingRemoval,
        switchTo,
        requestRemoval: setPendingRemoval,
        cancelRemoval: () => setPendingRemoval(null),
        confirmRemoval,
    }
}

type ServerSwitcher = ReturnType<typeof useServerSwitcher>

// The saved-server switcher.
//
// This surface matters more than it looks: useBreakpoint() buckets on WIDTH ALONE,
// with no Platform check, so a native tablet at >=768dp renders PackageRail + this
// menu and NEVER mounts MoreDrawer. Without this section an iPad — the device where
// a work server and a home server are most plausible — would have no switcher
// outside Settings.
//
// Remove is a submenu followed by a confirmation, so it is never one mis-tap away
// from a switch. Only the other servers are listed: leaving the current one is
// Disconnect, in Settings. Add is absent: Settings owns it.
function ServersSection({ switcher }: { switcher: ServerSwitcher }) {
    // Nothing to switch between: on web the list always contains at least the
    // current origin, so a lone entry would just be a label for where you already
    // are.
    if (switcher.servers.length < 2) return null

    return (
        <>
            <Menu.Separator />
            <Menu.Section label="Servers">
                {switcher.servers.map(server => (
                    <Menu.Item
                        key={server.origin}
                        label={server.label}
                        icon={Server}
                        isSelected={isSameServer(server.origin, switcher.activeOrigin)}
                        isDisabled={switcher.isBusy}
                        // A real href on web: the row IS a navigation there, so
                        // middle-click and open-in-new-tab should work. Native has
                        // no URL bar to hand it to.
                        href={webHref(server.origin, switcher.activeOrigin)}
                        onSelect={() => switcher.switchTo(server.origin)}
                    />
                ))}
                <Menu.Sub label="Remove server" icon={Trash2} isDisabled={switcher.isBusy}>
                    {switcher.others.map(server => (
                        <Menu.Item
                            key={server.origin}
                            label={server.label}
                            icon={Server}
                            isDestructive
                            onSelect={() => switcher.requestRemoval(server)}
                        />
                    ))}
                </Menu.Sub>
            </Menu.Section>
        </>
    )
}

function webHref(origin: string, activeOrigin: string): string | undefined {
    if (canSwitchInPlace()) return undefined
    return switchUrlFor(origin, activeOrigin)
}

// Native keeps a session per server, so removing one signs this device out of
// it. Web only forgets the address.
function removalMessage(server: SavedServer | null): string {
    if (!server) return ''
    if (canSwitchInPlace()) {
        return `This signs you out of ${server.label} on this device and removes it from your list. Your account on that server is not changed.`
    }
    return `This removes ${server.label} from your list in this browser. Your account on that server is not changed.`
}

function RemoveServerConfirm({ switcher }: { switcher: ServerSwitcher }) {
    return (
        <ConfirmDialog
            isOpen={!!switcher.pendingRemoval}
            onClose={switcher.cancelRemoval}
            onConfirm={switcher.confirmRemoval}
            title="Remove server?"
            message={removalMessage(switcher.pendingRemoval)}
            confirmLabel="Remove"
            isDestructive
            isSubmitting={switcher.isBusy}
            requiresServer={false}
        />
    )
}
