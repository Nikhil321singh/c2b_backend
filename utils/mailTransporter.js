import nodemailer from "nodemailer";
import dotenv from "dotenv";
dotenv.config();

const mailTransporter = nodemailer.createTransport({
    service: "gmail",
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
        user: process.env.MAIL,
        pass: process.env.MAIL_PASS,
    },
    // Give up quickly when the mail server cannot be reached (nodemailer
    // waits 2 minutes by default, which held every sale for minutes).
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
});

export default mailTransporter;
