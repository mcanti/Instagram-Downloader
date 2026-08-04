(() => {
    const IG_POST_REGEX_MAIN = /\/(p|tv|reel|reels)\/([A-Za-z0-9_-]*)(\/?)/;
    let nextContainerId = 0;

    // Full teardown on every SPA navigation, before the per-context handlers
    // further down re-observe for whatever the new URL actually needs.
    // Registered first so it runs before their own 'navigate' listeners
    // (listeners fire in registration order for the same target/type). The
    // functions/observers referenced here are only *called* once 'navigate'
    // actually fires, by which point the whole script below has finished
    // initializing them.
    navigation.addEventListener('navigate', (e) => {
        // Our own overlay downloads click a detached <a download> pointing at
        // a blob: URL, which the Navigation API reports as a real 'navigate'
        // event (destination.url is the blob URL, downloadRequest is set).
        // Treating that as an SPA navigation away from the current page would
        // disconnect every observer below without ever reconnecting them
        // (the URL never actually becomes '/' or whatever it "navigated" to
        // afterwards) - permanently breaking overlay rescans after the very
        // first download.
        if (e.downloadRequest !== null) return;
        feedObserver.disconnect();
        feedIntersectionObserver.disconnect();
        gridObserver.disconnect();
        gridIntersectionObserver.disconnect();
        reelsObserver.disconnect();
        storiesObserver.disconnect();
        window.removeEventListener('scroll', debouncedFeedScan);
    });
    /** containerId => the button element, so results can update it */
    const buttonRegistry = new Map();

    function createDownloadButton() {
        const button = document.createElement('button');
        button.className = 'igd-media-download-btn';
        button.type = 'button';
        button.title = 'Download';
        button.innerHTML =
            '<svg viewBox="0 0 24 24"><path d="M12 3v10.5m0 0-4-4m4 4 4-4M5 19h14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        return button;
    }

    function setButtonState(button, state) {
        button.classList.remove('igd-loading', 'igd-success', 'igd-error');
        if (state !== 'idle') button.classList.add(`igd-${state}`);
    }

    function requestDownload(button, detailWithoutId) {
        const containerId = `igd-${nextContainerId++}`;
        buttonRegistry.set(containerId, button);
        setButtonState(button, 'loading');
        window.dispatchEvent(
            new CustomEvent('mediaOverlayDownload', {
                detail: { containerId, ...detailWithoutId },
            }),
        );
    }

    window.addEventListener('mediaOverlayDownloadResult', (e) => {
        const { containerId, status } = e.detail;
        const button = buttonRegistry.get(containerId);
        if (!button) return;
        setButtonState(button, status);
        setTimeout(() => setButtonState(button, 'idle'), 1500);
        buttonRegistry.delete(containerId);
    });

    const overlayRoot = document.createElement('div');
    overlayRoot.id = 'igd-overlay-root';
    document.documentElement.appendChild(overlayRoot);

    /** scopeEl (article/dialog/link/etc) => { mode: 'actionbar'|'portal', anchor/insertionPoint, button } */
    const activeButtons = new Map();

    /**
     * Instagram's own action row (like/comment/share/save/...) already has a
     * Save icon - riding alongside it means our button never has to fight
     * Instagram's own click handling or stacking at all (unlike overlaying
     * the media itself, which Instagram's own click-catching layers always
     * win). Walks up from the Save `<svg>` until it reaches the element
     * whose parent has other children - that's the single list-item wrapper
     * for the whole Save button, at the same level as the like/comment/share
     * items - so a new sibling inserted right after it drops into the same
     * flex row/column (and inherits its gap) automatically, whether
     * Instagram is currently laying that row out horizontally (feed, post
     * modal, dedicated post page) or vertically (the reel viewer).
     */
    function findActionBarInsertionPoint(scopeEl) {
        let saveSvg = scopeEl.querySelector('svg[aria-label="Save"]');
        if (!saveSvg) {
            // The reels scroller can hand us a container reference whose
            // fiber-derived identity is briefly out of sync with what's
            // actually rendered right after an SPA navigation into a reel
            // (even though its position/size on screen is already correct)
            // - so a plain DOM descendant check can miss a Save icon that's
            // visibly right there. Fall back to whichever Save icon on the
            // page actually sits within scopeEl's own bounds.
            const scopeRect = scopeEl.getBoundingClientRect();
            if (scopeRect.width > 0 && scopeRect.height > 0) {
                saveSvg = Array.from(document.querySelectorAll('svg[aria-label="Save"]')).find((svg) => {
                    const r = svg.getBoundingClientRect();
                    return (
                        r.width > 0 &&
                        r.top >= scopeRect.top &&
                        r.bottom <= scopeRect.bottom &&
                        r.left >= scopeRect.left &&
                        r.right <= scopeRect.right
                    );
                });
            }
        }
        if (!saveSvg) return null;
        let el = saveSvg;
        while (el.parentElement && el.parentElement.children.length <= 1) el = el.parentElement;
        return el.parentElement ? el : null;
    }

    function makeButton(resolveDetail, extraButtonClass) {
        const button = createDownloadButton();
        if (extraButtonClass) button.classList.add(extraButtonClass);
        button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const detail = resolveDetail();
            if (!detail) return;
            requestDownload(button, detail);
        });
        return button;
    }

    /**
     * Attaches a download button for `scopeEl` (the article/dialog/link/reel
     * container/section that owns this button - exactly one button per
     * scope), preferring to place it next to Instagram's own Save icon
     * (see `findActionBarInsertionPoint`); falls back to a fixed-position
     * overlay glued to `mediaAnchor` (synced continuously in
     * `syncButtonPositions`) for contexts with no Save icon at all - grid/
     * explore thumbnails and the Stories/Highlights viewer.
     *
     * Re-calling for the same `scopeEl` moves the existing button instead of
     * creating a duplicate whenever the insertion point/anchor changed -
     * needed because the "best" media element (portal mode) or the action
     * row itself (action-bar mode) can be swapped out by Instagram across
     * rescans of the same scope (e.g. a carousel slide change, or a story's
     * real video mounting a moment after its avatar was the only thing
     * rendered yet).
     *
     * `resolveDetail` is called at click time (not attach time) so it always
     * reflects the currently-visible slide/frame.
     */
    function attachOverlayButton(scopeEl, mediaAnchor, resolveDetail, extraButtonClass) {
        const existing = activeButtons.get(scopeEl);
        const insertionPoint = findActionBarInsertionPoint(scopeEl);

        if (insertionPoint) {
            // Instagram's action row (like/comment/share/save/...) is laid
            // out with CSS grid on the feed/post-modal/dedicated-post-page
            // layout (with exactly as many explicit column tracks as its
            // current children) but with flexbox in the reel viewer.
            // Inserting a new item as a grid sibling has no track to land in
            // and gets auto-placed onto a new row - so for grid parents,
            // nest inside the (tiny, single-purpose) Save wrapper instead of
            // becoming a new sibling of it; for flex parents, being a new
            // sibling is exactly what already works (and is required for
            // the reel viewer's vertical list, whose gap comes from margins
            // between siblings, not from wrapping inside one item).
            const insertInsideWrapper = getComputedStyle(insertionPoint.parentElement).display === 'grid';
            const alreadyCorrect =
                existing &&
                existing.mode === 'actionbar' &&
                existing.insertionPoint === insertionPoint &&
                existing.insideWrapper === insertInsideWrapper &&
                (insertInsideWrapper
                    ? insertionPoint.lastElementChild === existing.button
                    : insertionPoint.nextElementSibling === existing.button);
            if (alreadyCorrect) return;
            if (existing) existing.button.remove();
            const button = makeButton(resolveDetail, extraButtonClass);
            button.classList.add('igd-media-download-btn--inline');
            if (insertInsideWrapper) {
                insertionPoint.style.display = 'flex';
                insertionPoint.style.alignItems = 'center';
                insertionPoint.appendChild(button);
            } else {
                if (getComputedStyle(insertionPoint.parentElement).flexDirection === 'column') {
                    button.classList.add('igd-media-download-btn--inline-vertical');
                }
                insertionPoint.insertAdjacentElement('afterend', button);
            }
            activeButtons.set(scopeEl, { mode: 'actionbar', insertionPoint, button, insideWrapper: insertInsideWrapper });
            return;
        }

        if (existing && existing.mode === 'portal' && existing.anchor === mediaAnchor) return;
        if (existing) existing.button.remove();
        const button = makeButton(resolveDetail, extraButtonClass);
        overlayRoot.appendChild(button);
        activeButtons.set(scopeEl, { mode: 'portal', anchor: mediaAnchor, button });
    }

    /**
     * Keeps every active portal-mode button's fixed position glued to its
     * anchor's current bounding rect, every frame. Also doubles as the sole
     * cleanup mechanism for both modes: once a button's reference element
     * (the anchor in portal mode, the button itself in action-bar mode) is
     * detached from the document - Instagram removed/replaced it, e.g. after
     * a click it doesn't handle the way we expect - it's dropped here rather
     * than via any explicit per-context teardown, so a later rescan can
     * attach a fresh one.
     */
    function syncButtonPositions() {
        activeButtons.forEach((entry, scopeEl) => {
            if (entry.mode === 'actionbar') {
                if (!entry.button.isConnected) activeButtons.delete(scopeEl);
                return;
            }
            const { anchor, button } = entry;
            if (!anchor.isConnected) {
                button.remove();
                activeButtons.delete(scopeEl);
                return;
            }
            const rect = anchor.getBoundingClientRect();
            if (rect.width < 10 || rect.height < 10) {
                button.style.display = 'none';
                return;
            }
            button.style.display = '';
            button.style.left = `${rect.left + rect.width / 2}px`;
            button.style.top = `${rect.bottom - 8 - 15}px`;
        });
        requestAnimationFrame(syncButtonPositions);
    }
    requestAnimationFrame(syncButtonPositions);

    /**
     * Finds the currently-visible media element inside `scopeEl` for a
     * non-carousel post/frame (single image/video). Picks the largest
     * rendered `<img>`/`<video>`, which reliably beats small decorative
     * images (e.g. the poster's avatar) - safe here specifically because
     * there's only ever one real piece of media to find.
     */
    function findActiveMediaElement(scopeEl) {
        const candidates = Array.from(scopeEl.querySelectorAll('video, img'));
        let best = null;
        let bestArea = 0;
        candidates.forEach((el) => {
            const rect = el.getBoundingClientRect();
            const area = rect.width * rect.height;
            if (area > bestArea) {
                bestArea = area;
                best = el;
            }
        });
        return best;
    }

    /**
     * Finds the currently-active slide's media element for a carousel post.
     * Each `<li>` has a fixed `transform: translateX(<n>px)` representing its
     * static position in the strip (slide 1 is always at 0, slide 2 at the
     * slide width, etc.) - which slide is actually *visible* is controlled
     * separately, by the nearest scrollable ancestor's `scrollLeft`. The
     * active `<li>` is therefore the one whose own translateX matches that
     * ancestor's scrollLeft, not simply "whichever li has translateX(0)"
     * (that's only true for the first slide). Falls back to
     * `findActiveMediaElement` for non-carousel posts (no `<ul>` at all) or
     * if no scrollable ancestor/matching li is found.
     */
    function findActiveSlideMediaElement(scopeEl) {
        const ul = scopeEl.querySelector('ul');
        if (ul) {
            const lis = Array.from(ul.querySelectorAll('li')).filter((li) => li.querySelector('img, video'));
            if (lis.length) {
                let scrollContainer = ul.parentElement;
                for (let i = 0; i < 6 && scrollContainer; i++) {
                    const overflowX = getComputedStyle(scrollContainer).overflowX;
                    if (
                        (overflowX === 'auto' || overflowX === 'scroll') &&
                        scrollContainer.scrollWidth > scrollContainer.clientWidth
                    ) {
                        break;
                    }
                    scrollContainer = scrollContainer.parentElement;
                }
                const scrollLeft = scrollContainer ? scrollContainer.scrollLeft : 0;
                const activeLi = lis.reduce((closest, li) => {
                    const match = (li.getAttribute('style') || '').match(/translateX\((-?\d+(?:\.\d+)?)px\)/);
                    const liOffset = match ? parseFloat(match[1]) : Infinity;
                    const closestMatch = (closest.getAttribute('style') || '').match(
                        /translateX\((-?\d+(?:\.\d+)?)px\)/,
                    );
                    const closestOffset = closestMatch ? parseFloat(closestMatch[1]) : Infinity;
                    return Math.abs(liOffset - scrollLeft) < Math.abs(closestOffset - scrollLeft) ? li : closest;
                }, lis[0]);
                const mediaEl = activeLi.querySelector('img, video');
                if (mediaEl) return mediaEl;
            }
        }
        return findActiveMediaElement(scopeEl);
    }

    /**
     * Carousel dot indicators (aria-label="Go to slide N") expose an
     * absolute, 0-indexed slide position via `aria-current="step"` on the
     * active one - this is a more reliable index source than inferring it
     * from `<li>` transforms, which can go stale immediately after the user
     * advances the carousel (Instagram doesn't always re-render `<li>`
     * offsets synchronously with the click). Not every context renders
     * these dots (e.g. the dedicated post page doesn't), so callers must
     * still fall back to `findActiveSlideMediaElement`'s pk-based guess.
     */
    function resolveDotIndex(scopeEl) {
        const dots = Array.from(scopeEl.querySelectorAll('button[aria-label^="Go to slide"]'));
        if (dots.length === 0) return null;
        const activeIndex = dots.findIndex((dot) => dot.getAttribute('aria-current') === 'step');
        return activeIndex === -1 ? null : activeIndex;
    }

    /**
     * Instagram wraps media in several layers of zero/near-zero-width
     * carousel-transform divs. Walk up from `startEl`'s parent until finding
     * an ancestor that's both sized like the visible media AND not the
     * `<img>`/`<video>` itself - those are replaced elements that never
     * render appended child nodes, so an anchor on the media tag directly
     * would leave the button in the DOM but permanently invisible.
     */
    function findSizedAnchor(startEl) {
        let el = startEl.parentElement;
        for (let i = 0; i < 8 && el; i++) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 10 && rect.height > 10) return el;
            el = el.parentElement;
        }
        return startEl.parentElement || startEl;
    }

    /**
     * Dedicated post/reel page (/p/:code, /reel/:code, /tv/:code, /reels/:code)
     * and the post modal opened from feed/grid/explore both expose the current
     * post's shortcode directly in the URL, so no ReactFiber lookup is needed
     * to identify which post is showing.
     */
    function scanPostPageOrModal() {
        const match = window.location.pathname.match(IG_POST_REGEX_MAIN);
        if (!match) return;
        // The vertical reels scroller (/reels/:code, plural) matches
        // IG_POST_REGEX_MAIN too (it also matches singular /reel/:code, the
        // dedicated single-reel page) but is handled exclusively by
        // scanReelsPlayers below - letting both scan the same URL would have
        // them fight over the same action-bar insertion point every rescan.
        if (match[1] === 'reels') return;
        const shortcode = match[2];
        const dialog = document.querySelector('div[role="dialog"]');
        const scope = dialog || document.querySelector('main');
        if (!scope) return;
        const mediaEl = findActiveSlideMediaElement(scope);
        if (!mediaEl) return;
        const anchor = findSizedAnchor(mediaEl);
        attachOverlayButton(scope, anchor, () => {
            const dotIndex = resolveDotIndex(scope);
            return {
                kind: 'post',
                shortcode,
                mediaId: dotIndex === null ? getValueByKey(findActiveSlideMediaElement(scope), 'pk') : null,
                index: dotIndex === null ? 0 : dotIndex,
            };
        });
    }

    const postPageObserver = new MutationObserver(scanPostPageOrModal);
    postPageObserver.observe(document.body, { childList: true, subtree: true });
    scanPostPageOrModal();

    /**
     * Home feed: unlike the dedicated page/modal, the URL stays "/" no matter
     * which post is showing, so each article's shortcode has to come from its
     * own ReactFiber (same lookup home-scroll-handler.js already relies on).
     */
    function scanPostArticle(article) {
        const postInfo = getValueByKey(article, 'queryReference');
        if (!postInfo || !postInfo.code) return;
        const mediaEl = findActiveSlideMediaElement(article);
        if (!mediaEl) return;
        const anchor = findSizedAnchor(mediaEl);
        attachOverlayButton(article, anchor, () => {
            const dotIndex = resolveDotIndex(article);
            return {
                kind: 'post',
                shortcode: postInfo.code,
                mediaId: dotIndex === null ? getValueByKey(findActiveSlideMediaElement(article), 'pk') : null,
                index: dotIndex === null ? 0 : dotIndex,
            };
        });
    }

    function debounce(fn, delay) {
        let timeoutId;
        return (...args) => {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => fn(...args), delay);
        };
    }

    // Feed can accumulate hundreds of loaded posts as the user scrolls, so
    // only attach buttons to articles near the viewport (±1 screen), and
    // never re-run the full-post detection logic for ones far off-screen.
    const feedIntersectionObserver = new IntersectionObserver(
        (entries) => {
            entries.forEach((entry) => {
                if (entry.isIntersecting) scanPostArticle(entry.target);
            });
        },
        { rootMargin: '100% 0px 100% 0px' },
    );

    function observeNewArticles(main) {
        main.querySelectorAll('article').forEach((article) => {
            if (article.dataset.igdObserved) {
                // Already tracked: re-scan directly rather than waiting on
                // another intersection change, since Instagram can replace
                // the carousel's active <li>/media node (e.g. on slide
                // navigation) without the article itself entering/leaving
                // the viewport, which would otherwise leave the button gone.
                scanPostArticle(article);
                return;
            }
            article.dataset.igdObserved = 'true';
            feedIntersectionObserver.observe(article);
        });
    }

    function scanFeedArticles() {
        const main = document.querySelector('main');
        if (!main) return;
        observeNewArticles(main);
    }

    const debouncedFeedScan = debounce(scanFeedArticles, Math.floor(1000 / 60));
    const feedObserver = new MutationObserver(debouncedFeedScan);

    function startFeedScan() {
        const main = document.querySelector('main');
        if (!main) return;
        feedObserver.observe(main, { childList: true, subtree: true });
        window.addEventListener('scroll', debouncedFeedScan);
        scanFeedArticles();
    }

    function stopFeedScan() {
        feedObserver.disconnect();
        window.removeEventListener('scroll', debouncedFeedScan);
    }

    navigation.addEventListener('navigate', (e) => {
        if (e.downloadRequest !== null) return;
        const url = new URL(e.destination.url);
        if (url.pathname === '/') startFeedScan();
        else stopFeedScan();
    });
    if (window.location.pathname === '/') startFeedScan();

    /**
     * Profile grid & Explore grid: thumbnails are plain <a href="/.../p/:code/">
     * links with no visible carousel navigation, so the shortcode comes
     * straight from the href and the download is always the cover (index 0).
     */
    function extractShortcodeFromHref(href) {
        const match = new URL(href, window.location.origin).pathname.match(IG_POST_REGEX_MAIN);
        return match ? match[2] : null;
    }

    function attachGridLink(link) {
        const shortcode = extractShortcodeFromHref(link.href);
        if (!shortcode) return;
        if (!link.querySelector('img, video')) return;
        attachOverlayButton(link, link, () => ({
            kind: 'post',
            shortcode,
            mediaId: null,
            index: 0,
        }));
    }

    const gridIntersectionObserver = new IntersectionObserver(
        (entries) => {
            entries.forEach((entry) => {
                if (entry.isIntersecting) attachGridLink(entry.target);
            });
        },
        { rootMargin: '100% 0px 100% 0px' },
    );

    function scanGridLinks() {
        document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]').forEach((link) => {
            if (link.dataset.igdObserved) return;
            link.dataset.igdObserved = 'true';
            gridIntersectionObserver.observe(link);
        });
    }

    const gridObserver = new MutationObserver(debounce(scanGridLinks, Math.floor(1000 / 60)));
    gridObserver.observe(document.body, { childList: true, subtree: true });
    scanGridLinks();

    /**
     * Finds the ancestor of `video` that also contains its Save icon -
     * bounded walk-up, same idea as `findActionBarInsertionPoint` but
     * starting from the video since a reel's container isn't reliably
     * reachable any other way (see `scanReelsPlayers`).
     */
    function findReelScope(video) {
        let el = video.parentElement;
        for (let i = 0; i < 15 && el; i++) {
            if (el.querySelector('svg[aria-label="Save"]')) return el;
            el = el.parentElement;
        }
        return null;
    }

    /**
     * Reels scroller (/reels/:code): always a single video, no carousel, so
     * the index is always 0. Identified the same way reels-scroll-handler.js
     * already does, via the PolarisClipsViewer_media_identifier fiber key,
     * but starting the search from every `<video>` on the page rather than
     * from `main > div > div` - a reel opened by clicking a video in the
     * feed (as opposed to navigating straight to /reels/:code) gets
     * rendered by Instagram as its own portal appended directly to
     * `<body>`, entirely outside `<main>`, so that selector never matched
     * it at all and no button was ever attached.
     *
     * Also: right after an SPA navigation into a reel, the fiber key above
     * can still read the *previous* reel's identifier for a while
     * (reachable via some shared fiber reference that lags behind the
     * actual URL/content change), even though the right video is already
     * playing - a plain page load never has this problem since there's no
     * previous reel to lag behind. For whichever container is actually in
     * view, the URL itself is the reliable source of truth for which post
     * is showing, so it wins over a mismatched fiber value.
     */
    function scanReelsPlayers() {
        const urlMatch = window.location.pathname.match(/\/(reels)\/([A-Za-z0-9_-]*)(\/?)/);
        const urlCode = urlMatch ? urlMatch[2] : null;
        document.querySelectorAll('video').forEach((video) => {
            const identifier = getValueByKey(video, 'PolarisClipsViewer_media_identifier');
            if (!identifier || !identifier.code) return;
            const scope = findReelScope(video);
            if (!scope) return;
            const rect = scope.getBoundingClientRect();
            const isInView = rect.top < window.innerHeight / 2 && rect.bottom > window.innerHeight / 2;
            const shortcode = isInView && urlCode ? urlCode : identifier.code;
            attachOverlayButton(scope, video.parentElement, () => ({
                kind: 'post',
                shortcode,
                mediaId: null,
                index: 0,
            }));
        });
    }

    const reelsObserver = new MutationObserver(debounce(scanReelsPlayers, Math.floor(1000 / 60)));

    navigation.addEventListener('navigate', (e) => {
        if (e.downloadRequest !== null) return;
        const url = new URL(e.destination.url);
        if (url.pathname.match(/\/(reels)\/([A-Za-z0-9_-]*)(\/?)/)) {
            reelsObserver.observe(document.body, { childList: true, subtree: true });
            scanReelsPlayers();
        } else {
            reelsObserver.disconnect();
        }
    });
    if (window.location.pathname.match(/\/(reels)\/([A-Za-z0-9_-]*)(\/?)/)) {
        reelsObserver.observe(document.body, { childList: true, subtree: true });
        scanReelsPlayers();
    }

    /**
     * Stories & Highlights: Instagram updates the URL to
     * /stories/:username/:framePk/ as you move between frames of the same
     * story, so (unlike posts) the active frame's pk can be read straight
     * from the pathname instead of any DOM/fiber inspection. On the very
     * first frame the pk segment isn't in the URL yet, which conveniently
     * matches the index-0 fallback. Highlights don't expose a frame pk this
     * way (their URL only carries the highlight id), so highlights always
     * fall back to index 0 (the first frame) - a known limitation.
     */
    const IG_STORY_REGEX_MAIN = /\/(stories)\/(.*?)\/(\d*)(\/?)/;
    const IG_HIGHLIGHT_REGEX_MAIN = /\/(stories)\/(highlights)\/(\d*)(\/?)/;

    function scanStoriesViewer() {
        if (!window.location.pathname.match(IG_STORY_REGEX_MAIN)) return;
        const section = Array.from(document.querySelectorAll('section')).pop();
        if (!section) return;
        const mediaEl = findActiveMediaElement(section);
        if (!mediaEl) return;
        const anchor = findSizedAnchor(mediaEl);
        const highlightMatch = window.location.pathname.match(IG_HIGHLIGHT_REGEX_MAIN);
        if (highlightMatch) {
            const highlightId = highlightMatch[3];
            attachOverlayButton(section, anchor, () => ({
                kind: 'highlight',
                highlightId,
                mediaId: null,
                index: 0,
            }));
            return;
        }
        const username = getValueByKey(section, 'username');
        if (!username) return;
        attachOverlayButton(section, anchor, () => {
            const frameMatch = window.location.pathname.match(IG_STORY_REGEX_MAIN);
            return {
                kind: 'stories',
                username,
                mediaId: frameMatch && frameMatch[3] ? frameMatch[3] : null,
                index: 0,
            };
        });
    }

    const storiesObserver = new MutationObserver(debounce(scanStoriesViewer, Math.floor(1000 / 60)));

    navigation.addEventListener('navigate', (e) => {
        if (e.downloadRequest !== null) return;
        const url = new URL(e.destination.url);
        if (url.pathname.match(IG_STORY_REGEX_MAIN)) {
            storiesObserver.observe(document.body, { childList: true, subtree: true });
            setTimeout(scanStoriesViewer, 0);
        } else {
            storiesObserver.disconnect();
        }
    });
    if (window.location.pathname.match(IG_STORY_REGEX_MAIN)) {
        storiesObserver.observe(document.body, { childList: true, subtree: true });
        scanStoriesViewer();
    }
})();
