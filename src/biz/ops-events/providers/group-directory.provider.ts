export const GROUP_DIRECTORY_PROVIDER = Symbol('GROUP_DIRECTORY_PROVIDER');

export interface HostingGroup {
  id: string;
  name: string;
  description?: string;
}
export interface GroupDirectoryProvider {
  getAllGroups(): Promise<HostingGroup[]>;
}
