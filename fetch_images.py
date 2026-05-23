import csv
import json
import os
import urllib.parse
import urllib.request

OWNER = "parepiy"
REPO = "novel"
BRANCH = "main"
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".bmp", ".ico", ".tiff", ".tif", ".avif", ".jpg"}

def fetch_tree():
    url = f"https://api.github.com/repos/{OWNER}/{REPO}/git/trees/{BRANCH}?recursive=1"
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "fetch-images-script"}
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())

def is_image(path):
    return any(path.lower().endswith(ext) for ext in IMAGE_EXTENSIONS)

def raw_url(path):
    return f"https://raw.githubusercontent.com/{OWNER}/{REPO}/{BRANCH}/{urllib.parse.quote(path)}"

def main():
    print("Fetching repository tree...")
    tree = fetch_tree()

    blobs = [item for item in tree.get("tree", []) if item["type"] == "blob"]
    images = [item for item in blobs if is_image(item["path"])]

    print(f"Found {len(images)} image file(s).")

    output = "images.csv"
    with open(output, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["filename", "path", "raw_url"])
        for item in images:
            path = item["path"]
            filename = path.split("/")[-1]
            writer.writerow([filename, path, raw_url(path)])

    print(f"Exported to {output}")

if __name__ == "__main__":
    main()
