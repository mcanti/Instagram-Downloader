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
