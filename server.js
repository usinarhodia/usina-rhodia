require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");
const express = require("express");
const cors = require("cors");
const { Payment } = require("mercadopago");
const { Resend } = require("resend");
const { MercadoPagoConfig, Preference } = require("mercadopago");

const resend = new Resend(process.env.RESEND_API_KEY);

const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN
});

const preferenceClient = new Preference(client);
const paymentClient = new Payment(client);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const app = express();

app.use(cors());
app.use(express.json());


app.post("/crear-preferencia", async (req, res) => {
  try {

    const items = req.body.items;

    const preference = {
        external_reference: req.body.order_id.toString(),
      items: items.map(item => ({
        title: item.nombre,
        quantity: item.cantidad,
        currency_id: "ARS",
        unit_price: Number(item.precio)
      })),

      back_urls: {
  success: `https://usina-rhodia-production.up.railway.app/success.html?order_id=${req.body.order_id}`,
  failure: "https://usina-rhodia-production.up.railway.app/failure.html",
  pending: "https://usina-rhodia-production.up.railway.app/pending.html"
},

auto_return: "approved",

    };

    const response = await preferenceClient.create({ body: preference });

    res.json({
  id: response.id,
  init_point: response.init_point
});

  } catch (error) {
  console.log("ERROR MERCADO PAGO:", error);

  res.status(500).json({
    error: "Error creando preferencia",
    detalle: error.message || error
  });
}
});

app.post("/webhook", async (req, res) => {

  try {

    console.log("Webhook recibido:", req.body);

    if (req.body.type === "payment") {

      const paymentId = req.body.data.id;

      const payment = await paymentClient.get({
        id: paymentId
      });

      console.log("Pago completo:", payment);

      if (payment.status === "approved") {

        const orderId = payment.external_reference;

        console.log("Pedido aprobado:", orderId);

        await supabase
          .from("orders")
          .update({
  status: "paid"
})
          .eq("id", orderId);

        console.log("Pedido actualizado a paid");

        const { data: pedidoMail } = await supabase
  .from("orders")
  .select("*")
  .eq("id", orderId)
  .single();

if(pedidoMail){

  await resend.emails.send({
    from: "USINA RHODIA <onboarding@resend.dev>",
    to: pedidoMail.customer_email,
    subject: `Tu compra fue aprobada #${orderId}`,
    html: `
      <div style="font-family:Arial;padding:20px;">
        <h1>Pago aprobado ✅</h1>

        <p>Hola ${pedidoMail.customer_name},</p>

        <p>Tu compra fue aprobada correctamente.</p>

        <p>
          Podés seguir tu pedido acá:
        </p>

        <a
          href="http://127.0.0.1:5500/pedido.html?id=${orderId}"
          style="
            display:inline-block;
            background:#ff2a2a;
            color:white;
            padding:14px 20px;
            border-radius:10px;
            text-decoration:none;
            font-weight:bold;
          "
        >
          Ver mi pedido
        </a>

      </div>
    `
  });

  console.log("Mail enviado");
}

        const { data: itemsPedido, error: errorItems } = await supabase
  .from("order_items")
  .select("*")
  .eq("order_id", orderId);

if (errorItems) {
  console.log("Error buscando items del pedido:", errorItems);
  return;
}

for (const item of itemsPedido) {
  const { data: stockActual, error: errorStock } = await supabase
    .from("product_stock")
    .select("*")
    .eq("product_id", item.product_id)
    .eq("size", item.size)
    .single();

  if (errorStock || !stockActual) {
    console.log("No se encontró stock para:", item);
    continue;
  }

  const nuevoStock = stockActual.stock - item.quantity;

  const { error: errorUpdateStock } = await supabase
    .from("product_stock")
    .update({
      stock: nuevoStock < 0 ? 0 : nuevoStock
    })
    .eq("id", stockActual.id);

  if (errorUpdateStock) {
    console.log("Error actualizando stock:", errorUpdateStock);
  } else {
    console.log(
      `Stock actualizado: producto ${item.product_id}, talle ${item.size}, nuevo stock ${nuevoStock}`
    );
  }
}

      }

    }

    res.sendStatus(200);

  } catch (error) {

    console.log("Error webhook:", error);

    res.sendStatus(500);

  }

});

app.listen(3000, () => {
  console.log("Servidor corriendo en puerto 3000");
});