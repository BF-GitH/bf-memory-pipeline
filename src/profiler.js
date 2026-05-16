// BF Memory Pipeline - Profile Switching Module
// Shared by Agent 1 (Drafter) and Agent 3 (Memory Updater)

function getContext() {
    return SillyTavern.getContext();
}

function getExtensionSettings() {
    return getContext().extensionSettings;
}

export function getConnectionProfiles() {
    try {
        const profiles = getExtensionSettings()?.connectionManager?.profiles;
        return Array.isArray(profiles) ? profiles : [];
    } catch {
        return [];
    }
}

export function getCurrentProfileId() {
    try {
        return getExtensionSettings()?.connectionManager?.selectedProfile || null;
    } catch {
        return null;
    }
}

export async function swapProfile(targetId) {
    try {
        const current = getExtensionSettings()?.connectionManager?.selectedProfile;
        const profiles = getExtensionSettings()?.connectionManager?.profiles;

        if (current === targetId) return false;

        if (!Array.isArray(profiles) || profiles.findIndex(p => p.id === targetId) < 0) {
            console.error('[BFMemory] Invalid profile ID:', targetId);
            return false;
        }

        const dropdown = document.getElementById('connection_profiles');
        if (!dropdown) return false;

        $('#connection_profiles').val(targetId);
        dropdown.dispatchEvent(new Event('change'));

        await new Promise((resolve) => {
            getContext().eventSource.once(
                getContext().eventTypes.CONNECTION_PROFILE_LOADED,
                resolve,
            );
        });

        return current;
    } catch (error) {
        console.error('[BFMemory] Error swapping profile:', error);
        return false;
    }
}

export async function restoreProfile(profileId) {
    if (!profileId) return false;

    try {
        const dropdown = document.getElementById('connection_profiles');
        if (!dropdown) return false;

        const loadPromise = new Promise((resolve) => {
            const timeout = setTimeout(() => resolve(), 3000);
            getContext().eventSource.once(
                getContext().eventTypes.CONNECTION_PROFILE_LOADED,
                () => { clearTimeout(timeout); resolve(); },
            );
        });

        $('#connection_profiles').val(profileId);
        dropdown.dispatchEvent(new Event('change'));
        await loadPromise;
        await new Promise(resolve => setTimeout(resolve, 500));
        return true;
    } catch (error) {
        console.error('[BFMemory] Error restoring profile:', error);
        return false;
    }
}

/**
 * Run an async function using the memory profile, then restore.
 * Agent 1 (Drafter) and Agent 3 (Memory Updater) use this.
 */
export async function runWithMemoryProfile(fn, settings) {
    if (!settings.useMemoryProfile || !settings.memoryProfile) {
        return await fn();
    }

    const originalProfile = getCurrentProfileId();
    const swapped = await swapProfile(settings.memoryProfile);

    if (swapped === false && getCurrentProfileId() !== settings.memoryProfile) {
        return await fn();
    }

    await new Promise(resolve => setTimeout(resolve, 500));

    try {
        return await fn();
    } finally {
        if (originalProfile && swapped !== false) {
            await restoreProfile(originalProfile);
        }
    }
}
