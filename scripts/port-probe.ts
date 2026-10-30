import * as net from 'node:net'

// The errors that mean this machine has no IPv6 address of that kind, so no IPv6
// listener can hold the port either.
const NO_IPV6 = new Set(['EAFNOSUPPORT', 'EADDRNOTAVAIL'])

// macOS lets a bind to one of these succeed while another holds the same port
// (a server on `*:port` or on `localhost`/::1 does not block a 127.0.0.1 bind), so
// every one is tried: a port is free only when none of them is taken.
const HOSTS = ['127.0.0.1', '0.0.0.0', '::1', '::'] as const

function canListen(port: number, host: string): Promise<boolean> {
    return new Promise(resolve => {
        const server = net.createServer()
        server.once('error', (err: NodeJS.ErrnoException) => {
            resolve(host.includes(':') && NO_IPV6.has(err.code ?? ''))
        })
        server.once('listening', () => {
            server.close(() => resolve(true))
        })
        server.listen(port, host)
    })
}

/**
 * Whether nothing listens on `port` on any local address. A bind to 127.0.0.1 alone
 * misses a process that holds the port on the IPv6 wildcard (as Expo does), on
 * 0.0.0.0, or on ::1, and the second server then fails to start.
 */
export async function isPortFree(port: number): Promise<boolean> {
    for (const host of HOSTS) {
        if (!(await canListen(port, host))) return false
    }
    return true
}
