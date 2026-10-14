import qrcode from 'qrcode-generator'

/**
 * The QR code for text as an SVG path of its dark modules, one unit per
 * module, plus the module count for the viewBox. Medium error correction is
 * what authenticator apps scan reliably at small sizes.
 */
export function qrPath(text: string): { path: string; size: number } {
    const qr = qrcode(0, 'M')
    qr.addData(text)
    qr.make()
    const size = qr.getModuleCount()
    const parts: string[] = []
    for (let row = 0; row < size; row++) {
        for (let col = 0; col < size; col++) {
            if (qr.isDark(row, col)) parts.push(`M${col} ${row}h1v1h-1z`)
        }
    }
    return { path: parts.join(''), size }
}
