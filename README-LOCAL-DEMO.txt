SAHAYAK DESK — LOCAL DEMO
===========================

IMPORTANT:
Is ZIP me compiled frontend hai; original project me backend/server/database files nahi hain.
Isliye maine local browser API adapter add kiya hai. Tickets, agents, settings, articles aur replies
browser ke localStorage me save hote hain. Ye testing/demo ke liye hai, production backend nahi.

START:
1. Is ZIP ko extract karein.
2. START-SAHAYAK.bat double-click karein.
   OR CMD:
      cd "D:\Sahayak Desk — Help Desk"
      npx --yes serve -l 3000 .
3. Browser me:
      http://localhost:3000

ADMIN:
Email: admin@sahayak.local
Password: admin123
Name: Sahayak Admin
Role: Admin

TEST AGENTS:
Rohit Verma
Email: rohit@sahayak.local
Password: demo123

Sneha Iyer
Email: sneha@sahayak.local
Password: demo123

CUSTOMER TEST:
Open:
http://localhost:3000/#/portal

Fill name/email/subject/detail/category/priority and submit.
Ticket number (HD-1002 etc.) milega.
Phir admin login karke Tickets page me ticket dekhein.
Customer portal me "Mera ticket status" se ticket number + same email se status check karein.

RESET LOCAL DATA:
Browser DevTools -> Application -> Local Storage -> localhost:3000 -> delete key:
sahayak-desk-local-v1

OR browser console:
localStorage.removeItem("sahayak-desk-local-v1"); location.reload();

The local adapter is intended to make this four-file compiled demo testable without a backend.
