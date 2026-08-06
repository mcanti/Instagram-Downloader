function createZipBlob(files) {
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    files.forEach((file) => {
        const name = encoder.encode(file.name);
        const crc = crc32(file.data);
        const localHeader = new ArrayBuffer(30);
        const localView = new DataView(localHeader);
        localView.setUint32(0, 0x04034b50, true);
        localView.setUint16(4, 20, true);
        localView.setUint16(6, 0x800, true);
        localView.setUint32(14, crc, true);
        localView.setUint32(18, file.data.length, true);
        localView.setUint32(22, file.data.length, true);
        localView.setUint16(26, name.length, true);
        localParts.push(new Uint8Array(localHeader), name, file.data);

        const centralHeader = new ArrayBuffer(46);
        const centralView = new DataView(centralHeader);
        centralView.setUint32(0, 0x02014b50, true);
        centralView.setUint16(4, 20, true);
        centralView.setUint16(6, 20, true);
        centralView.setUint16(8, 0x800, true);
        centralView.setUint32(16, crc, true);
        centralView.setUint32(20, file.data.length, true);
        centralView.setUint32(24, file.data.length, true);
        centralView.setUint16(28, name.length, true);
        centralView.setUint32(42, offset, true);
        centralParts.push(new Uint8Array(centralHeader), name);
        offset += 30 + name.length + file.data.length;
    });

    const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
    const end = new ArrayBuffer(22);
    const endView = new DataView(end);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(8, files.length, true);
    endView.setUint16(10, files.length, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, offset, true);
    return new Blob([...localParts, ...centralParts, new Uint8Array(end)], { type: 'application/zip' });
}

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function getJpegDimensions(bytes) {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('Unsupported image format');
    let offset = 2;
    while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) {
            offset++;
            continue;
        }
        const marker = bytes[offset + 1];
        offset += 2;
        if (marker === 0xd8 || marker === 0xd9) continue;
        if (offset + 2 > bytes.length) break;
        const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
        if (marker >= 0xc0 && marker <= 0xc3) {
            return {
                height: (bytes[offset + 3] << 8) | bytes[offset + 4],
                width: (bytes[offset + 5] << 8) | bytes[offset + 6],
            };
        }
        offset += segmentLength;
    }
    throw new Error('Could not read image dimensions');
}

function buildPdfBlob(images) {
    const pageWidth = 595;
    const pageHeight = 842;
    const encoder = new TextEncoder();
    const objects = [];
    const pageRefs = [];

    objects.push('<< /Type /Catalog /Pages 2 0 R >>');
    objects.push(null);

    images.forEach((image, index) => {
        const pageNumber = objects.length + 1;
        const contentNumber = pageNumber + 1;
        const imageNumber = pageNumber + 2;
        const scale = Math.min(pageWidth / image.width, pageHeight / image.height);
        const width = image.width * scale;
        const height = image.height * scale;
        const x = (pageWidth - width) / 2;
        const y = (pageHeight - height) / 2;
        const content = `${width.toFixed(2)} 0 0 ${height.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Im${index} Do`;

        pageRefs.push(`${pageNumber} 0 R`);
        objects.push(
            `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im${index} ${imageNumber} 0 R >> >> /Contents ${contentNumber} 0 R >>`,
        );
        objects.push(`<< /Length ${encoder.encode(content).length} >>\nstream\n${content}\nendstream`);
        objects.push({
            binary: image.data,
            prefix: `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.data.length} >>\nstream\n`,
        });
    });

    objects[1] = `<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${pageRefs.length} >>`;
    const parts = [encoder.encode('%PDF-1.4\n%\xff\xff\xff\xff\n')];
    const offsets = [0];
    let offset = parts[0].length;
    objects.forEach((object, index) => {
        offsets.push(offset);
        const header = encoder.encode(`${index + 1} 0 obj\n`);
        parts.push(header);
        offset += header.length;
        if (typeof object === 'string') {
            const bytes = encoder.encode(`${object}\nendobj\n`);
            parts.push(bytes);
            offset += bytes.length;
        } else {
            const prefix = encoder.encode(object.prefix);
            const suffix = encoder.encode('\nendstream\nendobj\n');
            parts.push(prefix, object.binary, suffix);
            offset += prefix.length + object.binary.length + suffix.length;
        }
    });
    const xrefOffset = offset;
    const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`];
    offsets.slice(1).forEach((objectOffset) => xref.push(`${String(objectOffset).padStart(10, '0')} 00000 n \n`));
    xref.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
    parts.push(encoder.encode(xref.join('')));
    return new Blob(parts, { type: 'application/pdf' });
}

window.addEventListener('mediaOverlayDownload', async (e) => {
    const { containerId, kind, shortcode, username, highlightId, mediaId, index } = e.detail;
    function reportResult(status) {
        window.dispatchEvent(
            new CustomEvent('mediaOverlayDownloadResult', {
                detail: { containerId, status },
            }),
        );
    }
    try {
        if (kind === 'post-all') {
            const data = await fetchPostMediaData(shortcode);
            if (!data || !data.media.length) return reportResult('error');
            const date = new Date(data.date * 1000).toISOString().split('T')[0];
            for (const item of data.media) {
                const fileName = `${data.user.username}_${item.id}_${date}${item.isVideo ? '.mp4' : '.jpeg'}`;
                await saveMediaItem(item, fileName);
            }
            return reportResult('success');
        }
        if (kind === 'post-all-zip') {
            const data = await fetchPostMediaData(shortcode);
            if (!data || !data.media.length) return reportResult('error');
            const date = new Date(data.date * 1000).toISOString().split('T')[0];
            const files = await Promise.all(
                data.media.map(async (item) => {
                    const response = await fetch(item.url);
                    const extension = item.isVideo ? '.mp4' : '.jpeg';
                    return {
                        name: `${data.user.username}_${item.id}_${date}${extension}`,
                        data: new Uint8Array(await response.arrayBuffer()),
                    };
                }),
            );
            const zipBlob = createZipBlob(files);
            saveFile(zipBlob, `${data.user.username}_${shortcode}_${date}.zip`);
            return reportResult('success');
        }
        if (kind === 'post-all-pdf') {
            const data = await fetchPostMediaData(shortcode);
            if (!data || !data.media.length) return reportResult('error');
            const date = new Date(data.date * 1000).toISOString().split('T')[0];
            const images = await Promise.all(
                data.media
                    .filter((item) => !item.isVideo)
                    .map(async (item) => {
                        const response = await fetch(item.url);
                        const imageData = new Uint8Array(await response.arrayBuffer());
                        const dimensions = getJpegDimensions(imageData);
                        return { data: imageData, ...dimensions };
                    }),
            );
            if (!images.length) return reportResult('error');
            saveFile(buildPdfBlob(images), `${data.user.username}_${shortcode}_${date}.pdf`);
            return reportResult('success');
        }
        let data = null;
        if (kind === 'post') data = await fetchPostMediaData(shortcode);
        else if (kind === 'stories') data = await fetchStoryMediaData(username);
        else if (kind === 'highlight') data = await fetchHighlightMediaData(highlightId);
        if (!data || !data.media.length) return reportResult('error');
        const matchedByIdItem = mediaId != null ? data.media.find((m) => String(m.id) === String(mediaId)) : null;
        const clampedIndex = Math.min(Math.max(index || 0, 0), data.media.length - 1);
        const item = matchedByIdItem || data.media[clampedIndex];
        const date = new Date(data.date * 1000).toISOString().split('T')[0];
        const fileName = `${data.user.username}_${item.id}_${date}${item.isVideo ? '.mp4' : '.jpeg'}`;
        await saveMediaItem(item, fileName);
        reportResult('success');
    } catch (error) {
        console.log(error);
        reportResult('error');
    }
});
