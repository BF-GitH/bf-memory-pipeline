// BF Memory Pipeline - Review Popup
// Every N messages, shows user all new/changed facts for review

let pendingReviewItems = [];
let messagesSinceLastReview = 0;

/**
 * Track a new fact update for eventual review
 * @param {Object} update - Fact update from Agent 3
 */
export function trackUpdate(update) {
    pendingReviewItems.push({
        ...update,
        timestamp: Date.now(),
        reviewed: false,
    });
}

/**
 * Increment message counter and check if review is due
 * @param {number} reviewInterval - How many messages between reviews
 * @returns {boolean} True if review popup should show
 */
export function tickMessageCounter(reviewInterval) {
    messagesSinceLastReview++;
    return messagesSinceLastReview >= reviewInterval && pendingReviewItems.length > 0;
}

/**
 * Reset the message counter (after review is shown)
 */
export function resetCounter() {
    messagesSinceLastReview = 0;
}

/**
 * Get pending items and clear the queue
 * @returns {Array}
 */
export function getPendingItems() {
    return [...pendingReviewItems];
}

/**
 * Clear all pending items (after user accepts)
 */
export function clearPendingItems() {
    pendingReviewItems = [];
}

/**
 * Show the review popup with all pending fact changes
 * @param {Function} onAccept - Callback when user accepts all
 * @param {Function} onEdit - Callback with edited items
 */
export async function showReviewPopup(onAccept, onEdit) {
    const items = getPendingItems();
    if (items.length === 0) return;

    const listHtml = items.map((item, idx) => {
        const actionClass = item.action === 'delete' ? 'bf-mem-delete' : item.action === 'update' ? 'bf-mem-update' : 'bf-mem-add';
        const actionLabel = item.action === 'delete' ? 'DEL' : item.action === 'update' ? 'UPD' : 'NEW';
        const knownBy = (item.knownBy || []).join(', ') || 'everyone';

        return `
            <div class="bf-mem-review-item ${actionClass}" data-idx="${idx}">
                <span class="bf-mem-action-badge">${actionLabel}</span>
                <span class="bf-mem-category">${escapeHtml(item.category)}</span>
                <input class="bf-mem-key" value="${escapeHtml(item.key)}" data-field="key" data-idx="${idx}" />
                <textarea class="bf-mem-value" data-field="value" data-idx="${idx}" rows="2">${escapeHtml(item.value || '')}</textarea>
                <span class="bf-mem-known">Known by: ${escapeHtml(knownBy)}</span>
                <button class="bf-mem-remove-btn" data-idx="${idx}" title="Remove this update">X</button>
            </div>`;
    }).join('');

    const html = `
        <div class="bf-mem-review-popup">
            <h3>Memory Review (${items.length} changes)</h3>
            <p>Review facts extracted from recent messages. Edit or remove before saving.</p>
            <div class="bf-mem-review-list">
                ${listHtml}
            </div>
            <div class="bf-mem-review-actions">
                <button id="bf_mem_accept_all" class="menu_button">Accept All</button>
                <button id="bf_mem_save_edited" class="menu_button">Save Edited</button>
                <button id="bf_mem_dismiss" class="menu_button">Dismiss</button>
            </div>
        </div>`;

    // Create modal overlay
    const overlay = document.createElement('div');
    overlay.id = 'bf_mem_review_overlay';
    overlay.innerHTML = html;
    document.body.appendChild(overlay);

    return new Promise((resolve) => {
        // Remove item button
        overlay.addEventListener('click', (e) => {
            if (e.target.classList.contains('bf-mem-remove-btn')) {
                const idx = parseInt(e.target.dataset.idx);
                const item = overlay.querySelector(`.bf-mem-review-item[data-idx="${idx}"]`);
                if (item) item.remove();
            }
        });

        // Accept all
        overlay.querySelector('#bf_mem_accept_all')?.addEventListener('click', () => {
            overlay.remove();
            clearPendingItems();
            resetCounter();
            onAccept?.();
            resolve('accepted');
        });

        // Save edited
        overlay.querySelector('#bf_mem_save_edited')?.addEventListener('click', () => {
            // Collect edited values
            const editedItems = [];
            overlay.querySelectorAll('.bf-mem-review-item').forEach((el) => {
                const idx = parseInt(el.dataset.idx);
                const original = items[idx];
                if (!original) return;

                const keyInput = el.querySelector('.bf-mem-key');
                const valueInput = el.querySelector('.bf-mem-value');

                editedItems.push({
                    ...original,
                    key: keyInput?.value || original.key,
                    value: valueInput?.value || original.value,
                });
            });

            overlay.remove();
            clearPendingItems();
            resetCounter();
            onEdit?.(editedItems);
            resolve('edited');
        });

        // Dismiss (keep items for next review)
        overlay.querySelector('#bf_mem_dismiss')?.addEventListener('click', () => {
            overlay.remove();
            resetCounter();
            resolve('dismissed');
        });
    });
}

function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
