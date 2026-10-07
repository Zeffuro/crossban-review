function matches(bytes: Uint8Array, signature: number[], offset = 0): boolean {
    return signature.every((value, index) => bytes[offset + index] === value);
}

export function imageType(bytes: Uint8Array): 'png' | 'jpg' | 'webp' | null {
    if (matches(bytes, [137, 80, 78, 71, 13, 10, 26, 10])) return 'png';
    if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
    if (matches(bytes, [82, 73, 70, 70]) && matches(bytes, [87, 69, 66, 80], 8)) return 'webp';
    return null;
}

export function validImage(bytes: Uint8Array, mime: string): boolean {
    return imageType(bytes) === ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as Record<string, string>)[mime];
}
