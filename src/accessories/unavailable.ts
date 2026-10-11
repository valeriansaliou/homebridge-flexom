import type { API, PlatformAccessory } from 'homebridge';

/** Makes HomeKit show "No response" until the zone is set up again */
export function markUnavailable({
  api,
  accessory,
}: {
  api: API;
  accessory: PlatformAccessory;
}) {
  const { Characteristic, HapStatusError, HAPStatus, Perms, Service } = api.hap;
  const unavailable = () => {
    throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  };
  for (const service of accessory.services) {
    if (service.UUID === Service.AccessoryInformation.UUID) continue;
    for (const characteristic of service.characteristics) {
      if (characteristic.UUID === Characteristic.Name.UUID) continue;
      characteristic.onGet(unavailable);
      if (characteristic.props.perms.includes(Perms.PAIRED_WRITE)) {
        characteristic.onSet(unavailable);
      }
    }
  }
}
