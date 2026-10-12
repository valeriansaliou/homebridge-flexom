/**
 * This is the name of the platform that users will use to register the plugin in the Homebridge config.json
 */
export const PLATFORM_NAME = 'Flexom';

/**
 * This must match the name of your plugin as defined the package.json
 *
 * Although this fork lives in the "@valeriansaliou" repository, the
 * "@rsauget" prefix must be kept: Homebridge identifies cached accessories by
 * plugin name, so people using the original (non-forked) plugin can upgrade
 * without having to redo their home setup (rooms, scenes, automations).
 */
export const PLUGIN_NAME = '@rsauget/homebridge-flexom';
