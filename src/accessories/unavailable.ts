import type { API, PlatformAccessory } from 'homebridge';

/** Cached accessories whose zone is not set up yet */
const unavailableAccessories = new WeakSet<PlatformAccessory>();

/**
 * Makes HomeKit show "No response" until the zone is set up again. Setting
 * up a zone binds the characteristics it drives; those it only updates
 * (e.g. a sensor's fault status) answer with their value once it is done.
 */
export function markUnavailable({
  api,
  accessory,
}: {
  api: API;
  accessory: PlatformAccessory;
}) {
  const { Characteristic, HapStatusError, HAPStatus, Perms, Service } = api.hap;
  const checkAvailable = () => {
    if (unavailableAccessories.has(accessory)) {
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  };
  unavailableAccessories.add(accessory);
  for (const service of accessory.services) {
    if (service.UUID === Service.AccessoryInformation.UUID) continue;
    for (const characteristic of service.characteristics) {
      if (characteristic.UUID === Characteristic.Name.UUID) continue;
      characteristic.onGet(() => {
        checkAvailable();
        return characteristic.value;
      });
      if (characteristic.props.perms.includes(Perms.PAIRED_WRITE)) {
        characteristic.onSet(checkAvailable);
      }
    }
  }
}

/** Once its zone is set up, an accessory answers HomeKit again */
export function markAvailable(accessory: PlatformAccessory) {
  unavailableAccessories.delete(accessory);
}
