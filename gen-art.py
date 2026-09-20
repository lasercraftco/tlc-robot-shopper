# Test artwork in every format shoppers upload: PNG, JPG, iPhone HEIC, PDF.
from PIL import Image, ImageDraw
import pillow_heif
pillow_heif.register_heif_opener()
im = Image.new('RGB', (1200, 900), 'white')
d = ImageDraw.Draw(im)
d.ellipse((250, 100, 950, 800), fill=(20, 40, 120))
d.rectangle((520, 380, 680, 520), fill='white')
im.save('art.jpg', quality=88)
im.save('art.heic')
im.save('art.pdf')
