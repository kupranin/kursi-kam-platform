# SMS through GoSMS, WhatsApp through Meta

The platform sends the messages itself. Make.com and Twilio are not used. The Georgian text is what gets sent. Email is not sent on this path.

Who receives a message is unchanged: each person chooses SMS, WhatsApp, or both on **Admin → People**, and each message type is switched on under **Admin → Messages**.

## Connect the two accounts

In the Supabase SQL editor, paste `supabase/setup/13_direct_messages.sql` and run it. Then store the real values.

GoSMS (the API key from app.gosms.ge, and the sender name they approved):

```sql
select vault.create_secret('your-sms-key', 'sms_api_key', 'GoSMS API key');
select vault.create_secret('Kursi', 'sms_sender', 'GoSMS sender name');
```

Meta WhatsApp. In Meta Business settings, open the WhatsApp product and copy the permanent token and the phone number id (the id, not the phone number):

```sql
select vault.create_secret('EAAxxxxxxxx', 'meta_whatsapp_token', 'Meta WhatsApp token');
select vault.create_secret('1234567890', 'meta_phone_number_id', 'Meta phone number id');
```

A first WhatsApp message has to use a template Meta has already approved. Make one Georgian template with a single body variable, then:

```sql
select vault.create_secret('kursi_notice', 'meta_template_name', 'Approved WhatsApp template');
select vault.create_secret('ka', 'meta_template_lang', 'Template language code');
```

You can connect only SMS, or only WhatsApp. The other channel waits until its secrets are stored.

## Check

On **Admin → Messages**, each role should say it is connected. Send a test. The row should move to delivered. If GoSMS or Meta refuses it, the error is on that row. Georgian SMS text is limited to 402 characters.
