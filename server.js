require("dotenv").config();

const crypto = require("crypto");
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
app.use((req, res, next) => {
  const bloqueados = [
    "/server.js",
    "/package.json",
    "/package-lock.json",
    "/.env",
    "/.gitignore"
  ];

  if (bloqueados.includes(req.path)) {
    return res.sendStatus(404);
  }

  next();
});

app.use(express.static(__dirname));


app.post("/crear-preferencia", async (req, res) => {
  try {
    const { cliente, items } = req.body;

    if (!cliente || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Datos inválidos" });
    }

    const { nombre, apellido, email, telefono, dni, entrega, direccion, depto, ciudad, cp } = cliente;

    if (!nombre || !apellido || !email || !telefono || !dni || !entrega || !direccion || !ciudad || !cp) {
      return res.status(400).json({ error: "Faltan datos del cliente o facturación" });
    }

    let total = 0;
    const itemsValidados = [];

    for (const item of items) {
      const productId = item.product_id;
      const talle = item.talle;
      const color = item.color || "";
      const cantidad = Number(item.cantidad);

      if (!productId || !talle || !cantidad || cantidad <= 0) {
        return res.status(400).json({ error: "Producto inválido" });
      }

      const { data: producto, error: errorProducto } = await supabase
        .from("products")
        .select("*")
        .eq("id", productId)
        .eq("active", true)
        .single();

      if (errorProducto || !producto) {
        return res.status(400).json({ error: "Producto no encontrado o inactivo" });
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
        color,
        size: talle,
        quantity: cantidad,
        unit_price: precioReal,
        subtotal,
coditm: producto.coditm
      });
    }

    const { data: intento, error: errorIntento } = await supabase
      .from("checkout_attempts")
      .insert({
        cliente,
        items: itemsValidados,
        total,
        status: "pending"
      })
      .select()
      .single();

    if (errorIntento) {
      console.log("Error creando intento:", errorIntento);
      return res.status(500).json({ error: "Error creando intento de pago" });
    }

    const preference = {
      external_reference: intento.id.toString(),

      items: itemsValidados.map(item => ({
        title: item.product_name,
        quantity: item.quantity,
        currency_id: "ARS",
        unit_price: item.unit_price
      })),

      back_urls: {
        success: `https://usina-rhodia-production.up.railway.app/success.html?attempt_id=${intento.id}`,
        failure: "https://usina-rhodia-production.up.railway.app/failure.html",
        pending: "https://usina-rhodia-production.up.railway.app/pending.html"
      },

      auto_return: "approved"
    };

    const response = await preferenceClient.create({ body: preference });

    res.json({
      id: response.id,
      init_point: response.init_point,
      attempt_id: intento.id
    });

  } catch (error) {
    console.log("ERROR CREAR PREFERENCIA SEGURA:", error);

    res.status(500).json({
      error: "Error creando preferencia segura",
      detalle: error.message || error
    });
  }
});

function crearAdminToken(){
  const payload = {
    role: "admin",
    exp: Date.now() + 1000 * 60 * 60 * 4
  };

  const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString("base64url");

  const firma = crypto
    .createHmac("sha256", process.env.ADMIN_SESSION_SECRET)
    .update(payloadBase64)
    .digest("base64url");

  return `${payloadBase64}.${firma}`;
}

function verificarAdmin(req, res, next){
  const auth = req.headers.authorization || "";
  const token = auth.replace("Bearer ", "");

  if(!token){
    return res.status(401).json({ error: "No autorizado" });
  }

  const [payloadBase64, firma] = token.split(".");

  const firmaCorrecta = crypto
    .createHmac("sha256", process.env.ADMIN_SESSION_SECRET)
    .update(payloadBase64)
    .digest("base64url");

  if(firma !== firmaCorrecta){
    return res.status(401).json({ error: "Token inválido" });
  }

  const payload = JSON.parse(Buffer.from(payloadBase64, "base64url").toString());

  if(Date.now() > payload.exp){
    return res.status(401).json({ error: "Sesión vencida" });
  }

  next();
}

async function getBasToken(){
  const form = new FormData();

  form.append("grant_type", "password");
  form.append("client_id", process.env.BAS_CLIENT_ID);
  form.append("client_secret", process.env.BAS_CLIENT_SECRET);
  form.append("refresh_token", "");
  form.append("username", process.env.BAS_USERNAME);
  form.append("password", process.env.BAS_PASSWORD);

  const response = await fetch(`${process.env.BAS_URL}/auth/token`, {
    method: "POST",
    headers: {
      "accept": "text/plain"
    },
    body: form
  });

  if(!response.ok){
    const text = await response.text();
    throw new Error(`Error BAS token: ${text}`);
  }

  const data = await response.json();
  return data.access_token;
}

function hoyBas(){
  return new Date().toISOString().slice(0, 10);
}

function talleBas(talle){
  const mapa = {
    XS: "0XS",
    S: "00S",
    M: "00M",
    L: "00L",
    XL: "0XL",
    XXL: "XXL",
    XXXL: "3XL"
  };

  return mapa[talle] || talle;
}

function extraerColorBas(color){
  const match = String(color || "").match(/\(([^)]+)\)/);
  return match ? match[1] : color;
}

function calcularImportes(precioFinal, cantidad){
  const total = Number(precioFinal) * Number(cantidad);
  const gravado = Math.round(total / 1.21);
  const iva = total - gravado;

  return { total, gravado, iva };
}

async function buscarClienteBasPorDni(dni){
  const token = await getBasToken();

  const response = await fetch(`${process.env.BAS_URL}/api/CONSULTAGRAL/Cliente`, {
    method: "POST",
    headers: {
      "accept": "text/plain",
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      HEADER: {
        ETIQUETA: "CONSULTAGRAL",
        CODEMP: 1,
        CODSUC: 1,
        FECHA: "30-06-2026"
      },
      ConsultaGral: {
        FiltrosAdicionales: [
          {
            TagEntidad: "Cliente",
            NombreCampo: "NumeroImpositivo1",
            Comparacion: "0",
            Valor: dni
          }
        ]
      }
    })
  });

  const data = await response.json();
  return data?.Cuerpo?.CLIENTES?.[0] || null;
}

async function crearClienteBas(cliente){
  const token = await getBasToken();
  const dni = String(cliente.dni).replace(/\D/g, "");
  const nombreCompleto = `${cliente.nombre} ${cliente.apellido}`;

  const response = await fetch(`${process.env.BAS_URL}/api/Clientes`, {
    method: "POST",
    headers: {
      "accept": "text/plain",
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      Codigo: dni,
      RazonSocial: nombreCompleto,
      Email: cliente.email,
      TratImpositivo: "C08",
      NumeroImpositivoTipo: "95",
      NumeroImpositivo1: dni,
      TodosSuspendidos: false,
      FechaAlta: hoyBas(),
      EmpresaAlta: 1,
      TratImpositivoProv: "C08",
      Fechareg: new Date().toISOString(),
      Contactos: [
        {
          Nombre: nombreCompleto,
          Email: cliente.email,
          Telefono: cliente.telefono,
          Observaciones: "",
          Cheques: false,
          Cobranzas: false,
          Ventas: false,
          EnvioCmp: true
        }
      ],
      CondicionesVenta: [
        {
          Codigo: "001",
          PorDefecto: true,
          ListaEstandar: "5"
        }
      ],
      Domicilios: [
        {
          Descripcion: "Principal",
          Domicilio1: cliente.direccion || "",
          Domicilio2: cliente.depto || "",
          CodigoPostal: cliente.cp || "",
          Localidad: cliente.ciudad || "",
          Provincia: "902",
          Pais: "ARG",
          Telefono: cliente.telefono,
          Observaciones: "",
          NroOrden: 1,
          Principal: true,
          Habilitado: true
        }
      ],
      Empresas: [
        {
          Codigo: 1
        }
      ]
    })
  });

  const data = await response.json();

  if(!response.ok){
    throw new Error("Error creando cliente BAS: " + JSON.stringify(data));
  }

  return data;
}

async function crearFacturaBas(cliente, itemsValidados, total){
  const token = await getBasToken();
  const dni = String(cliente.dni).replace(/\D/g, "");

  const itemsBas = itemsValidados.map(item => {
    const importes = calcularImportes(item.unit_price, item.quantity);

    return {
      CodigoItem: item.coditm,
      Color: extraerColorBas(item.color),
      Talle: talleBas(item.size),
      PendienteRemitirFacturar: "N",
      NumeroUnidadMedida: "1",
      CantidadPrimeraUnidad: item.quantity,
      PrecioUnitario: item.unit_price,
      PorcentajeBonificacion: 0,
      PorcentajeSegundaBonificacion: 0,
      ImporteTotal: importes.total,
      ImporteGravado: importes.gravado,
      ImporteIva: importes.iva,
      TasaIva: 21,
      Deposito: 112
    };
  });

  const totalGravado = itemsBas.reduce((acc, item) => acc + item.ImporteGravado, 0);
  const totalIva = itemsBas.reduce((acc, item) => acc + item.ImporteIva, 0);

  const response = await fetch(`${process.env.BAS_URL}/api/ComprobantesVenta?IgnoraAdvertencias=false`, {
    method: "POST",
    headers: {
      "accept": "text/plain",
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      Fecha: hoyBas(),
      Comprobante: "FB",
      Prefijo: "00105",
      Cliente: dni,
      TotalGravado: totalGravado,
      TotalIva: totalIva,
      Total: total,
      MetodoPago: "D",
      ImputacionContable: "640000000",
      Caja: "1",
      Deposito: 112,
      Empresa: 1,
      Sucursal: 1,
      FechaCreacion: new Date().toISOString(),
      TratImpositivo: "C08",
      TratImpositivoProv: "C08",
      CondicionVentaCompra: "001",
      ObservacionEntrega: "",
      ObservacionComprobante: "Venta ecommerce Usina Rhodia",
      EntregaEn: "",
      Usuario: "AP",
      Items: itemsBas,
      Efectivos: [
        {
          MedioPago: "NPS",
          Importe: total
        }
      ]
    })
  });

  const data = await response.json();

  if(!response.ok){
    throw new Error("Error creando factura BAS: " + JSON.stringify(data));
  }

  return data;
}

app.post("/admin/login", (req, res) => {
  const { password } = req.body;

  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({
      success: false,
      error: "Contraseña incorrecta"
    });
  }

  res.json({
    success: true,
    token: crearAdminToken()
  });
});

app.get("/admin/productos", verificarAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from("products")
    .select("*")
    .order("id", { ascending: false });

  if (error) return res.status(400).json({ error });

  res.json({ success: true, productos: data });
});

app.get("/admin/pedidos", verificarAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from("orders")
    .select(`
      *,
      order_items (*)
    `)
    .order("id", { ascending: false });

  if (error) return res.status(400).json({ error });

  res.json({ success: true, pedidos: data });
});

app.post("/admin/crear-producto", verificarAdmin, async (req, res) => {
  try {
    const {
      brand,
      name,
      old_price,
      price,
      discount,
      coditm,
      bas_color,
      bas_color_name,
      imageUrls,
      stocks
    } = req.body;

    const { data: producto, error: errorProducto } = await supabase
      .from("products")
      .insert({
        brand,
        name,
        old_price,
        price,
        discount,
        coditm,
        bas_color,
        bas_color_name,
        active: true
      })
      .select()
      .single();

    if (errorProducto) {
      console.log("Error creando producto:", errorProducto);
      return res.status(400).json({ error: "Error creando producto" });
    }

    const imagenesParaInsertar = imageUrls.map((url, index) => ({
      product_id: producto.id,
      image_url: url,
      position: index + 1
    }));

    const { error: errorImagenes } = await supabase
      .from("product_images")
      .insert(imagenesParaInsertar);

    if (errorImagenes) {
      console.log("Error creando imágenes:", errorImagenes);
      return res.status(400).json({ error: "Error creando imágenes" });
    }

    const stockParaInsertar = stocks.map(item => ({
  product_id: producto.id,
  size: item.size,
  color: item.color,
  color_name: item.color_name,
  stock: item.stock
}));

    const { error: errorStock } = await supabase
      .from("product_stock")
      .insert(stockParaInsertar);

    if (errorStock) {
      console.log("Error creando stock:", errorStock);
      return res.status(400).json({ error: "Error creando stock" });
    }

    res.json({
      success: true,
      product_id: producto.id
    });

  } catch (error) {
    console.log("Error admin crear producto:", error);
    res.status(500).json({ error: "Error interno creando producto" });
  }
});

app.post("/admin/eliminar-producto", verificarAdmin, async (req, res) => {
  try {
    const { id } = req.body;

    if (!id) {
      return res.status(400).json({ error: "Falta ID" });
    }

    await supabase.from("product_stock").delete().eq("product_id", id);
    await supabase.from("product_images").delete().eq("product_id", id);

    const { error } = await supabase
      .from("products")
      .delete()
      .eq("id", id);

    if (error) {
      console.log("Error eliminando producto:", error);
      return res.status(400).json({ error: "Error eliminando producto" });
    }

    res.json({ success: true });
  } catch (error) {
    console.log("Error admin eliminar producto:", error);
    res.status(500).json({ error: "Error interno eliminando producto" });
  }
});

app.post("/admin/desactivar-producto", verificarAdmin, async (req, res) => {
  try {
    const { id } = req.body;

    if (!id) {
      return res.status(400).json({ error: "Falta ID" });
    }

    const { error } = await supabase
      .from("products")
      .update({ active: false })
      .eq("id", id);

    if (error) {
      console.log("Error desactivando producto:", error);
      return res.status(400).json({ error: "Error desactivando producto" });
    }

    res.json({ success: true });

  } catch (error) {
    console.log("Error admin desactivar producto:", error);
    res.status(500).json({ error: "Error interno" });
  }
});

app.post("/admin/cambiar-estado-pedido", verificarAdmin, async (req, res) => {
  try {
    const { id, status } = req.body;

    const estadosPermitidos = [
      "paid",
      "preparado",
      "enviado",
      "entregado",
      "ready_pickup",
      "picked_up"
    ];

    if (!id || !status || !estadosPermitidos.includes(status)) {
      return res.status(400).json({ error: "Datos inválidos" });
    }

    const { error } = await supabase
      .from("orders")
      .update({ status })
      .eq("id", id);

    if (error) {
      console.log("Error cambiando estado:", error);
      return res.status(400).json({ error: "Error cambiando estado" });
    }

    res.json({ success: true });

  } catch (error) {
    console.log("Error admin cambiar estado:", error);
    res.status(500).json({ error: "Error interno cambiando estado" });
  }
});

app.post("/admin/guardar-tracking", verificarAdmin, async (req, res) => {
  try {
    const { id, tracking_code, tracking_url } = req.body;

    if (!id) {
      return res.status(400).json({
        error: "Falta ID"
      });
    }

    const { error } = await supabase
      .from("orders")
      .update({
        tracking_code,
        tracking_url
      })
      .eq("id", id);

    if (error) {
      console.log("Error guardando tracking:", error);
      return res.status(400).json({
        error: "Error guardando tracking"
      });
    }

    res.json({
      success: true
    });

  } catch (error) {
    console.log("Error admin tracking:", error);
    res.status(500).json({
      error: "Error interno"
    });
  }
});

app.get("/order-by-attempt/:attemptId", async (req, res) => {
  try {
    const { attemptId } = req.params;

    const { data: order, error } = await supabase
      .from("orders")
      .select("id, tracking_token, status")
      .eq("checkout_attempt_id", attemptId)
      .single();

    if (error || !order) {
      return res.status(404).json({
        success: false,
        error: "Pedido no encontrado"
      });
    }

    res.json({
      success: true,
      order
    });

  } catch (error) {
    console.log("Error buscando pedido por attempt:", error);
    res.status(500).json({
      success: false,
      error: "Error interno"
    });
  }
});

app.get("/admin/bas-test", verificarAdmin, async (req, res) => {
  try {
    const token = await getBasToken();

    res.json({
      success: true,
      message: "BAS conectado correctamente",
      token_inicio: token.slice(0, 20)
    });

  } catch (error) {
    console.log("Error BAS test:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

async function obtenerPagoMercadoPago(paymentId){
  for(let intento = 1; intento <= 3; intento++){
    try{
      const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: {
          Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`
        }
      });

      if(!response.ok){
        const text = await response.text();
        throw new Error(`MercadoPago status ${response.status}: ${text}`);
      }

      return await response.json();

    }catch(error){
      console.log(`Error consultando pago MP intento ${intento}:`, error.message);

      if(intento === 3){
        throw error;
      }

      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }
}

app.post("/webhook", async (req, res) => {
  try {
    console.log("Webhook recibido:", req.body);

    if (req.body.type !== "payment") {
      return res.sendStatus(200);
    }

    const paymentId = req.body.data.id;

    const payment = await obtenerPagoMercadoPago(paymentId);

    console.log("Pago completo:", payment);

    if (payment.status !== "approved") {
      return res.sendStatus(200);
    }

    const attemptId = payment.external_reference;

    console.log("Intento aprobado:", attemptId);

    const { data: intento, error: errorIntento } = await supabase
      .from("checkout_attempts")
      .select("*")
      .eq("id", attemptId)
      .single();

    if (errorIntento || !intento) {
      console.log("No se encontró checkout_attempt:", errorIntento);
      return res.sendStatus(200);
    }

    if (intento.status === "paid") {
      console.log("Intento ya procesado, no se duplica pedido");
      return res.sendStatus(200);
    }

    const cliente = intento.cliente;
    const itemsValidados = intento.items;
    const total = intento.total;
const trackingToken = crypto.randomUUID();
    const { data: pedido, error: errorPedido } = await supabase
      .from("orders")
      .insert({
        customer_name: cliente.nombre + " " + cliente.apellido,
        customer_email: cliente.email,
        customer_phone: cliente.telefono,
        customer_dni: cliente.dni,
        delivery_method: cliente.entrega,
        address: cliente.direccion || "",
        floor_apartment: cliente.depto || "",
        city: cliente.ciudad || "",
        postal_code: cliente.cp || "",
        total: total,
        status: "paid",
tracking_token: trackingToken,
checkout_attempt_id: intento.id
      })
      .select()
      .single();

    if (errorPedido) {
      console.log("Error creando pedido final:", errorPedido);
      return res.sendStatus(500);
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
      console.log("Error creando items finales:", errorItems);
      return res.sendStatus(500);
    }

    try {
  const dniCliente = String(cliente.dni).replace(/\D/g, "");

  let clienteBas = await buscarClienteBasPorDni(dniCliente);

  if (!clienteBas) {
    await crearClienteBas(cliente);
    clienteBas = await buscarClienteBasPorDni(dniCliente);
  }

  const facturaBas = await crearFacturaBas(cliente, itemsValidados, total);

  await supabase
    .from("orders")
    .update({
      bas_cliente: clienteBas?.Codigo || dniCliente,
      bas_estado: "facturado",
      bas_response: facturaBas,
      bas_factura: facturaBas?.Cuerpo?.Comprobantes?.[0]?.Numero || null
    })
    .eq("id", pedido.id);

  console.log("Factura BAS creada:", facturaBas);

} catch (errorBas) {
  console.log("Error integrando BAS:", errorBas.message);

  await supabase
    .from("orders")
    .update({
      bas_estado: "error",
      bas_response: {
        error: errorBas.message
      }
    })
    .eq("id", pedido.id);
}

    await supabase
      .from("checkout_attempts")
      .update({
        status: "paid"
      })
      .eq("id", attemptId);

    console.log("Pedido final creado:", pedido.id);

    for (const item of itemsValidados) {
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

    await resend.emails.send({
      from: "USINA RHODIA <onboarding@resend.dev>",
      to: cliente.email,
      subject: `Tu compra fue aprobada #${pedido.id}`,
      html: `
        <div style="font-family:Arial;padding:20px;">
          <h1>Pago aprobado ✅</h1>

          <p>Hola ${cliente.nombre} ${cliente.apellido},</p>

          <p>Tu compra fue aprobada correctamente.</p>

          <p>Podés seguir tu pedido acá:</p>

          <a
            href="https://usina-rhodia-production.up.railway.app/pedido.html?token=${trackingToken}"
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

    return res.sendStatus(200);

  } catch (error) {
    console.log("Error webhook:", error);
    return res.sendStatus(500);
  }
});

app.listen(3000, () => {
  console.log("Servidor corriendo en puerto 3000");
});