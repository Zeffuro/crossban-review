export function imageType(bytes: Buffer): 'png' | 'jpg' | 'webp' | null {
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
    if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
    if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'webp';
    return null;
}

export function validImage(bytes: Buffer, mime: string): boolean {
    return imageType(bytes) === ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as Record<string, string>)[mime];
}
