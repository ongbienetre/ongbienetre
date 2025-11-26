require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const nodemailer = require("nodemailer");
const fetch = require("node-fetch");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Upload config
const upload = multer({ dest: "uploads/" });

// PostgreSQL pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // utile sur Render/Heroku
});

// Fonction pour générer un numéro unique
async function getNextNumero() {
  const res = await pool.query("SELECT nextval('adherent_seq')");
  return "M-" + String(res.rows[0].nextval).padStart(4, "0");
}

// Route principale : adhésion
app.post("/api/membership", upload.single("photo"), async (req, res) => {
  console.log("✅ Route /api/membership appelée");
  try {
    const numero = await getNextNumero();

    const data = {
      numero,
      nom: req.body.nom,
      prenoms: req.body.prenoms,
      naissance: req.body.naissance,
      lieu: req.body.lieu,
      piece: req.body.piece,
      numero_piece: req.body.numero_piece,
      pays: req.body.pays,
      ville: req.body.ville,
      tel: req.body.tel,
      email: req.body.email,
      profession: req.body.profession,
      sexe: req.body.sexe,
      nationalite: req.body.nationalite,
      niveau: req.body.niveau,
      motivation: req.body.motivation,
      payAdhesion: req.body.payAdhesion === "true",
      payCotisation: req.body.payCotisation === "true",
      photoPath: req.file?.path || null,
    };

    // Sauvegarde JSON
    const adherentsDir = path.join(__dirname, "adherents");
    if (!fs.existsSync(adherentsDir)) fs.mkdirSync(adherentsDir);
    const adherentPath = path.join(adherentsDir, `${numero}.json`);
    fs.writeFileSync(adherentPath, JSON.stringify(data, null, 2));

    // Génération PDF
    const pdfPath = path.join(adherentsDir, `${numero}.pdf`);
    const pdfStream = fs.createWriteStream(pdfPath);
    const doc = new PDFDocument();
    doc.pipe(pdfStream);

    doc.font("Times-Bold").fontSize(18).fillColor("#004aad")
      .text("FORMULAIRE D'ADHÉSION À L'ONG Bien-Être", { align: "center" })
      .moveDown(0.5)
      .font("Times-Roman").fontSize(14).fillColor("black")
      .text(`Bulletin d'adhésion N° : ${numero}`, { align: "center" })
      .moveDown(1);

    const champs = [
      ["Nom", data.nom],
      ["Prénoms", data.prenoms],
      ["Date de naissance", data.naissance],
      ["Lieu de naissance", data.lieu],
      ["Sexe", data.sexe],
      ["Nationalité", data.nationalite],
      ["Profession", data.profession],
      ["Email", data.email],
      ["Téléphone", data.tel],
      ["Ville", data.ville],
      ["Pays", data.pays],
      ["Pièce", `${data.piece} — ${data.numero_piece}`],
      ["Niveau d’étude", data.niveau],
      ["Motivation", data.motivation],
      ["Adhésion payée", data.payAdhesion ? "✅ Oui" : "❌ Non"],
      ["Cotisation payée", data.payCotisation ? "✅ Oui" : "❌ Non"],
    ];

    champs.forEach(([label, value]) => {
      doc.fontSize(12).text(`${label} : ${value}`);
    });

    if (data.photoPath) {
      doc.addPage().fontSize(16).text("Photo de l’adhérent", { align: "center" });
      doc.moveDown();
      doc.image(data.photoPath, { fit: [250, 250], align: "center", valign: "center" });
    }

    doc.end();

    // Envoi email après génération du PDF
    pdfStream.on("finish", () => {
      console.log("📄 PDF terminé, envoi de l’email...");

      if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
        console.error("❌ Variables EMAIL_USER ou EMAIL_PASS manquantes");
        return;
      }

      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS,
        },
      });

      const mailOptions = {
        from: process.env.EMAIL_USER,
        to: process.env.EMAIL_USER, // ✅ tu peux mettre une autre adresse ici
        subject: `Nouvelle adhésion : ${numero}`,
        text: `Un nouvel adhérent vient de s’inscrire.\nNuméro : ${numero}\nNom : ${data.nom} ${data.prenoms}`,
        attachments: [
          { filename: `${numero}.pdf`, path: pdfPath },
          ...(data.photoPath ? [{ filename: "photo.jpg", path: data.photoPath }] : []),
        ],
      };

      transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
          console.error("❌ Erreur envoi email :", error);
        } else {
          console.log("📧 Email envoyé :", info.response);
        }
      });
    });

    // Paiement CinetPay
    let paymentUrl = null;
    if (data.payAdhesion || data.payCotisation) {
      const montant = (data.payAdhesion ? 5000 : 0) + (data.payCotisation ? 10000 : 0);

      const payload = {
        site_id: process.env.CINETPAY_SITE_ID,
        api_key: process.env.CINETPAY_API_KEY,
        transaction_id: numero,
        amount: montant,
        currency: "XOF",
        description: "Adhésion ONG Bien-être",
        return_url: process.env.CINETPAY_RETURN_URL,
        cancel_url: process.env.CINETPAY_CANCEL_URL,
        customer_name: data.nom,
        customer_email: data.email,
      };

      try {
        const response = await fetch("https://api-checkout.cinetpay.com/v2/payment", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const result = await response.json();
        if (result.code === "201") {
          paymentUrl = result.data.payment_url;
        }
      } catch (err) {
        console.error("❌ Erreur CinetPay :", err);
      }
    }

    res.json({ success: true, numero, paymentUrl });
  } catch (err) {
    console.error("❌ Erreur serveur :", err);
    res.json({ success: false, message: "Erreur serveur" });
  }
});

// Route infos.json
//app.get('/Backend/infos', (req, res) => {
  //const infosPath = path.join(__dirname, "infos.json");
  //try {
    //const raw = fs.readFileSync(infosPath);
    //const messages = JSON.parse(raw);
    //res.json(messages);
  //} catch (err) {
    //console.error("❌ Erreur lecture infos.json :", err);
    //res.status(500).json({ error: "Impossible de charger les infos" });
 // }
//});

app.listen(PORT, () => {
  console.log(`✅ Serveur lancé sur http://localhost:${PORT}`);
});
