// BF's Memory Pipeline - Main Entry Point
// 3-agent memory system: Draft -> Retrieve -> Write -> Update

export const extension_name = 'bf-memory-pipeline';

jQuery(async () => {
    try {
        const { initSettings } = await import('./src/settings.js');
        await initSettings();

        const { initPipeline } = await import('./src/pipeline.js');
        initPipeline();

        const { initMessageIcons } = await import('./src/message-icon.js');
        initMessageIcons();

        console.log('[BFMemory] Extension loaded successfully');
    } catch (error) {
        console.error('[BFMemory] Failed to load extension:', error);
    }
});
