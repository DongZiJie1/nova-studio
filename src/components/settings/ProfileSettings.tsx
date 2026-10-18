import { AvatarSettings } from "./AvatarSettings";

export function ProfileSettings() {
  return <>
    <header className="settings-page-header"><h1>个性化</h1><p>选择你和 Nova 在工作空间中的形象。</p></header>
    <div className="profile-avatar-list"><AvatarSettings kind="user" /><AvatarSettings kind="nova" /></div>
  </>;
}
