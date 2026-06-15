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
app.use(express.static(__dirname));


app.post("/crear-preferencia", async (req, res) => {
  try {
    const { cliente, items } = req.body;

    if (!cliente || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        error: "Datos inválidos"
      });
    }

    const {
      nombre,
      apellido,
      email,
      telefono,
      dni,
      entrega,
      direccion,
      depto,
      ciudad,
      cp
    } = cliente;

    if (!nombre || !apellido || !email || !telefono || !dni || !entrega) {
      return res.status(400).json({
        error: "Faltan datos del cliente"
      });
    }

    if (entrega === "Envío a domicilio" && (!direccion || !ciudad || !cp)) {
      return res.status(400).json({
        error: "Faltan datos de envío"
      });
    }

    let total = 0;
    const itemsValidados = [];

    for (const item of items) {
      const productId = item.product_id;
      const talle = item.talle;
      const color = item.color || "";
      const cantidad = Number(item.cantidad);

      if (!productId || !talle || !cantidad || cantidad <= 0) {
        return res.status(400).json({
          error: "Producto inválido"
        });
      }

      const { data: producto, error: errorProducto } = await supabase
        .from("products")
        .select("*")
        .eq("id", productId)
        .eq("active", true)
        .single();

      if (errorProducto || !producto) {
        return res.status(400).json({
          error: "Producto no encontrado o inactivo"
        });
      }

      const { data: stock, error: errorStock } = await supabase
        .from("product_stock")
        .select("*")
        .eq("product_id", productId)
        .eq("size", talle)
        .single();

      if (errorStock || !stock) {
        return res.status(400).json({
          error: `No hay stock para ${producto.name} talle ${talle}`
        });
      }

      if (stock.stock < cantidad) {
        return res.status(400).json({
          error: `Stock insuficiente para ${producto.name} talle ${talle}`
        });
      }

      const precioReal = Number(producto.price);
      const subtotal = precioReal * cantidad;

      total += subtotal;

      itemsValidados.push({
        product_id: producto.id,
        product_name: producto.name,
        color: color,
        size: talle,
        quantity: cantidad,
        unit_price: precioReal,
        subtotal: subtotal
      });
    }

    const { data: pedido, error: errorPedido } = await supabase
      .from("orders")
      .insert({
        customer_name: nombre + " " + apellido,
        customer_email: email,
        customer_phone: telefono,
        customer_dni: dni,
        delivery_method: entrega,
        address: direccion || "",
        floor_apartment: depto || "",
        city: ciudad || "",
        postal_code: cp || "",
        total: total,
        status: "pending"
      })
      .select()
      .single();

    if (errorPedido) {
      console.log("Error creando pedido:", errorPedido);

      return res.status(500).json({
        error: "Error creando pedido"
      });
    }

    const itemsParaInsertar = itemsValidados.map(item => ({
      order_id: pedido.id,
      product_id: item.product_id,
      product_name: item.product_name,
      color: item.color,
      size: item.size,
      quantity: item.quantity,
      unit_price: item.unit_price
    }));

    const { error: errorItems } = await supabase
      .from("order_items")
      .insert(itemsParaInsertar);

    if (errorItems) {
      console.log("Error guardando items:", errorItems);

      return res.status(500).json({
        error: "Error guardando productos del pedido"
      });
    }

    const preference = {
      external_reference: pedido.id.toString(),

      items: itemsValidados.map(item => ({
        title: item.product_name,
        quantity: item.quantity,
        currency_id: "ARS",
        unit_price: item.unit_price
      })),

      back_urls: {
        success: `https://usina-rhodia-production.up.railway.app/success.html?order_id=${pedido.id}`,
        failure: "https://usina-rhodia-production.up.railway.app/failure.html",
        pending: "https://usina-rhodia-production.up.railway.app/pending.html"
      },

      auto_return: "approved"
    };

    const response = await preferenceClient.create({ body: preference });

    res.json({
      id: response.id,
      init_point: response.init_point,
      order_id: pedido.id
    });

  } catch (error) {
    console.log("ERROR CREAR PREFERENCIA SEGURA:", error);

    res.status(500).json({
      error: "Error creando preferencia segura",
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

        const { data: pedidoActual } = await supabase
  .from("orders")
  .select("status")
  .eq("id", orderId)
  .single();

if (pedidoActual?.status === "paid") {
  console.log("Pedido ya procesado, no se descuenta stock otra vez");
  return res.sendStatus(200);
}

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
          href="https://usina-rhodia-production.up.railway.app/pedido.html?id=${orderId}"
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