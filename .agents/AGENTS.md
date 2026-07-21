# Project Agent Rules

### 🛡️ Auditing & Merging Console Configurations
- **Verify Existing Settings**: When proposing changes to third-party console rules (such as Firebase/Firestore Security Rules, Supabase RLS, or AWS IAM Policies), always ask the user to provide their current rules, or look for backup files in the repository first.
- **Merge, Don't Override**: Never suggest overwriting existing console rules with a generic baseline. Instead, merge the new requirements into the user's existing config, highlighting exactly what was changed and why.

### 🚨 Manual User Actions & Flags
- **Highlight Manual Actions**: Every time there is an action or setup step that cannot be automated by the agent and must be performed manually by the user (such as copying rules into the Firebase Console, configuring environment variables, or creating API keys), flag it clearly with an emergency emoji (like `🚨` or `⚠️`) and provide exact, step-by-step instructions.

### 🚀 App Store Launch Reminders
- **iOS Setup Hook**: Whenever the user mentions launching to the App Store, submitting the app, or configuring the app on macOS, proactively remind them that we created the `setup_ios.py` automation script in the root directory. Explain that this script automates creating the iOS Capacitor directory and injecting camera/location permission descriptions into `Info.plist` on their new Mac.
