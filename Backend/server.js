require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const nodemailer = require("nodemailer");

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Upload config
const upload = multer({ dest: "uploads/" });

// Numérotation
const numberFile = "last_number.txt";
let lastNumber = fs.existsSync(numberFile) ? parseInt(fs.readFileSync(numberFile)) : 0;

// Route principale
app.post("/api/membership", upload.single("photo"), async (req, res) => {
  console.log("✅ Route /api/membership appelée");
  try {
    console.log("📥 Données reçues :", req.body);
    console.log("📸 Fichier reçu :", req.file);
    lastNumber++;
    fs.writeFileSync(numberFile, lastNumber.toString());

    const numero = "M-" + String(lastNumber).padStart(4, "0");

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
      payAdhesion: Array.isArray(req.body.payAdhesion) ? req.body.payAdhesion.includes("true") : req.body.payAdhesion === "true",
      payCotisation: Array.isArray(req.body.payCotisation) ? req.body.payCotisation.includes("true") : req.body.payCotisation === "true",
      photoPath: req.file?.path || null,
    };

    const adherentPath = path.join(__dirname, "adherents", `${numero}.json`);
    fs.writeFileSync(adherentPath, JSON.stringify(data, null, 2));

    // 📄 Générer le PDF
    const pdfPath = path.join(__dirname, "adherents", `${numero}.pdf`);
    const pdfStream = fs.createWriteStream(pdfPath);
    const doc = new PDFDocument();
    doc.pipe(pdfStream);

    doc.image("images/logo.png", 50, 40, { width: 80 }).moveDown(2);
    doc
      .font("Times-Bold")
      .fontSize(18)
      .fillColor("#004aad")
      .text("FORMULAIRE D'ADHÉSION À L'ONG Bien-Être", { align: "center" })
      .moveDown(0.5)
      .font("Times-Roman")
      .fontSize(14)
      .fillColor("black")
      .text(`Bulletin d'adhésion N° : ${numero}`, { align: "center" })
      .moveDown(1);

    doc.fontSize(18).text(`Fiche d’adhésion — ${numero}`, { align: "center" });
    doc.moveDown();
    doc.fontSize(14).fillColor("black").text("Informations personnelles", { underline: true });
    doc.moveDown(0.5);

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
      doc.image(data.photoPath, {
        fit: [250, 250],
        align: "center",
        valign: "center",
      });
    }

    doc.end();

    // 📧 Envoi email après génération du PDF
    pdfStream.on("finish", () => {
      console.log("📄 PDF terminé, envoi de l’email...");

      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS,
        },
      });

      const mailOptions = {
        from: process.env.EMAIL_USER,
        to: process.env.EMAIL_USER,
        subject: `Nouvelle adhésion : ${numero}`,
        text: `Un nouvel adhérent vient de s’inscrire.\nNuméro : ${numero}\nNom : ${data.nom} ${data.prenoms}`,
        attachments: [
          {
            filename: `${numero}.pdf`,
            path: pdfPath,
          },
          {
            filename: "photo.jpg",
            path: data.photoPath,
          },
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

    // Paiement fictif
    let paymentUrl = null;
    if (data.payAdhesion || data.payCotisation) {
      const montant = (data.payAdhesion ? 5000 : 0) + (data.payCotisation ? 10000 : 0);
      paymentUrl = `https://paiement.ongbienetre.org/initier?montant=${montant}&ref=${numero}`;
    }

    console.log("✅ Réponse envoyée :", { numero, paymentUrl });
    res.json({ success: true, numero, paymentUrl });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: "Erreur serveur" });
  }
});

app.get("/api/infos", (req, res) => {
  const infosPath = path.join(__dirname, "infos.json");
  try {
    const raw = fs.readFileSync(infosPath);
    const messages = JSON.parse(raw);
    res.json(messages);
  } catch (err) {
    console.error("❌ Erreur lecture infos.json :", err);
    res.status(500).json({ error: "Impossible de charger les infos" });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Serveur lancé sur http://localhost:${PORT}`);
});