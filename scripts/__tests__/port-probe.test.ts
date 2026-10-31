import * as net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { isPortFree } from '../port-probe'

const servers: net.Server[] = []

function listenOn(host: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer()
        servers.push(server)
        server.once('error', reject)
        server.listen(0, host, () => resolve((server.address() as net.AddressInfo).port))
    })
}

function closeAll() {
    return Promise.all(servers.splice(0).map(s => new Promise(r => s.close(r))))
}

afterEach(closeAll)

describe('isPortFree', () => {
    it.each(['127.0.0.1', '0.0.0.0', '::1', '::'])('is false for a port held on %s', async host => {
        expect(await isPortFree(await listenOn(host))).toBe(false)
    })

    it('is true for a port nothing holds', async () => {
        // A dual-stack bind picks a port that no address family holds.
        const port = await listenOn('::')
        await closeAll()
        expect(await isPortFree(port)).toBe(true)
    })
})
