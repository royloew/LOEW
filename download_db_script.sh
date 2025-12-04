#!/usr/bin/env bash
set -euo pipefail

# כתובת השירות שלך ברנדר
BASE_URL="https://loew.onrender.com"  # תעדכן אם ה-URL שונה

# אותו SECRET כמו ב-DB_DOWNLOAD_SECRET ברנדר
SECRET="roy_super_secret_2025"

# שם קובץ עם timestamp כדי שלא ידרסו אחד את השני
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
OUT_FILE="loew_db_${TIMESTAMP}.db"

echo "מוריד DB מרנדר ל-${OUT_FILE}..."

curl -fSL "${BASE_URL}/admin/download-db?key=${SECRET}" -o "${OUT_FILE}"

echo "סיים ✅"
echo "הקובץ נשמר כ: ${OUT_FILE}"
