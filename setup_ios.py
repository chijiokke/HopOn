import os
import sys
import subprocess

def run_command(cmd):
    print(f"Running: {cmd}")
    result = subprocess.run(cmd, shell=True)
    if result.returncode != 0:
        print(f"Error executing command: {cmd}")
        return False
    return True

def main():
    # 1. Check OS
    if sys.platform != "darwin":
        print("🚨 WARNING: iOS apps can only be initialized and built on macOS (MacBook/Mac mini/etc).")
        print("Please run this script again once you are on your Mac!")
        sys.exit(1)

    print("🚀 Initializing iOS Capacitor project...")
    
    # 2. Add and Sync Capacitor iOS
    if not os.path.exists("ios"):
        if not run_command("npx cap add ios"):
            sys.exit(1)
    else:
        print("✓ iOS directory already exists.")

    if not run_command("npx cap sync ios"):
        sys.exit(1)

    # 3. Locate Info.plist
    plist_path = os.path.join("ios", "App", "App", "Info.plist")
    if not os.path.exists(plist_path):
        print(f"❌ Error: Info.plist not found at expected location: {plist_path}")
        sys.exit(1)

    # 4. Modify Info.plist to insert App Store permissions
    print("✍️ Configuring App Store camera and location descriptions in Info.plist...")
    try:
        with open(plist_path, "r", encoding="utf-8") as f:
            content = f.read()

        # Check if keys are already present
        modified = False
        camera_key = "<key>NSCameraUsageDescription</key>"
        location_key = "<key>NSLocationWhenInUseUsageDescription</key>"

        insert_text = ""
        if camera_key not in content:
            insert_text += "	<key>NSCameraUsageDescription</key>\n	<string>HopOn requires camera access to capture parcel pickup and drop-off photo proof.</string>\n"
        if location_key not in content:
            insert_text += "	<key>NSLocationWhenInUseUsageDescription</key>\n	<string>HopOn requires location access to track active rides and cargo package transits.</string>\n"

        if insert_text:
            # Info.plist is an XML document. We want to insert our key/strings right after the first <dict> tag
            dict_tag = "<dict>"
            if dict_tag in content:
                content = content.replace(dict_tag, f"{dict_tag}\n{insert_text}", 1)
                modified = True

        if modified:
            with open(plist_path, "w", encoding="utf-8") as f:
                f.write(content)
            print("🎉 Info.plist updated successfully with required App Store permissions!")
        else:
            print("✓ App Store permissions are already configured in Info.plist.")

    except Exception as e:
        print(f"❌ Failed to update Info.plist: {e}")
        sys.exit(1)

    print("\n✅ Ready to build! You can now open Xcode and build the app:")
    print("👉 Run: npx cap open ios")

if __name__ == "__main__":
    main()
